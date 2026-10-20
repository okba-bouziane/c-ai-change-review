import * as path from 'node:path';
import * as vscode from 'vscode';
import { relativeTo } from '../core/paths';
import type { Baseline, DetectedChange, ReviewRecord, SessionData } from '../core/session';
import type { ChangedFile, ReviewStatus } from '../core/types';
import { captureBaseline } from '../services/baseline';
import { ChangeTracker } from '../services/changeTracker';
import { isAbort } from '../services/fileState';
import { Git } from '../services/git';
import {
  acceptMany,
  rejectMany,
  undoLast,
  type ActionDeps,
  type ActionOptions,
  type ActionReport,
} from '../services/actions';
import { readBaselineBytes } from '../services/restore';
import { applyRetention } from '../storage/retention';
import { applyEditEvent, deleteEvent, readPendingEvents } from '../hooks/hookEvents';
import { isEditEvent } from '../hooks/protocol';
import type { SessionStore } from '../storage/sessionStore';
import type { SnapshotStore } from '../storage/snapshotStore';
import { readConfig, SECTION } from './config';

const REFRESH_DEBOUNCE_MS = 300;

/** Everything known about one entry in the panel, keyed by root-relative path. */
export interface ReviewItem {
  readonly key: string;
  readonly status: ReviewStatus;
  /** The pending change, when status is 'pending'. */
  readonly change?: DetectedChange;
  /** The decision, when status is 'accepted' or 'rejected'. */
  readonly record?: ReviewRecord;
}

export interface ControllerDeps {
  readonly folder: vscode.WorkspaceFolder;
  readonly sessions: SessionStore;
  readonly snapshots: SnapshotStore;
  readonly log: vscode.LogOutputChannel;
  readonly viewId: string;
  readonly gitPath: string | undefined;
}

/**
 * Owns the active review session for one workspace folder: captures the baseline, listens
 * for file changes, and recomputes the change list. Refreshes are debounced, never run
 * concurrently, and are cancelled when a newer one supersedes them.
 */
export class ReviewController implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<readonly ChangedFile[]>();
  private readonly stopEmitter = new vscode.EventEmitter<number>();
  /** Fires with the number of pending changes when Claude Code reports that it stopped. */
  readonly onClaudeStopped = this.stopEmitter.event;
  /** True once any hook event arrived, so "unattributed" is meaningful to show. */
  private hooksSeen = false;
  /** Fires with the latest change list after every successful refresh. */
  readonly onDidChange = this.changeEmitter.event;

  private readonly disposables: vscode.Disposable[] = [this.changeEmitter, this.stopEmitter];
  private session: SessionData | undefined;
  private tracker: ChangeTracker | undefined;
  private git: Git | undefined;
  private changes: DetectedChange[] = [];
  /** Serializes accept/reject so two decisions never interleave. */
  private actionQueue: Promise<unknown> = Promise.resolve();

  private debounceTimer: NodeJS.Timeout | undefined;
  private pendingHints = new Set<string>();
  private pendingFull = false;
  /** Set whenever something requested a refresh that has not started yet. */
  private dirty = false;
  private running: Promise<void> | undefined;
  private abort: AbortController | undefined;
  private disposed = false;

  constructor(private readonly deps: ControllerDeps) {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(deps.folder, '**/*'),
    );
    const onEvent = (uri: vscode.Uri): void => {
      this.onFileEvent(uri);
    };
    this.disposables.push(
      watcher,
      watcher.onDidCreate(onEvent),
      watcher.onDidChange(onEvent),
      watcher.onDidDelete(onEvent),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(SECTION, deps.folder)) {
          this.scheduleRefresh({ full: true });
        }
      }),
    );
  }

  get activeSession(): SessionData | undefined {
    return this.session;
  }

  get detectedChanges(): readonly DetectedChange[] {
    return this.changes;
  }

  /** The panel entry for a root-relative path, if there is one. */
  item(key: string): ReviewItem | undefined {
    const change = this.changes.find((c) => c.path === key);
    if (change) {
      return { key, status: 'pending', change };
    }
    const record = this.session?.reviews[key];
    return record ? { key, status: record.status, record } : undefined;
  }

  /** Root-relative key for a file URI in this session, if it is inside the session root. */
  keyForFile(fsPath: string): string | undefined {
    return this.session ? relativeTo(this.session.root, fsPath) : undefined;
  }

  /** Absolute path of a root-relative key. */
  absolutePath(key: string): string | undefined {
    return this.session ? path.join(this.session.root, key) : undefined;
  }

  /** Reads a baseline's bytes for display. Undefined for 'absent'. */
  async readBaseline(baseline: Baseline, key: string): Promise<Buffer | undefined> {
    return readBaselineBytes(baseline, key, this.deps.snapshots, this.git);
  }

  /** True when there is a review action that can be undone. */
  get canUndo(): boolean {
    return (this.session?.history.length ?? 0) > 0;
  }

  /** Short description of the action Undo would reverse, e.g. "reject of 3 files". */
  describeUndo(): string | undefined {
    const entry = this.session?.history.at(-1);
    if (!entry) {
      return undefined;
    }
    const [first] = entry.items;
    const what = entry.items.length === 1 && first ? first.key : `${entry.items.length} files`;
    return `${entry.action === 'accept' ? 'Accept' : 'Reject'} of ${what}`;
  }

  /** Pending changes for the given keys, in the given order. */
  pendingChanges(keys: readonly string[]): DetectedChange[] {
    return keys.flatMap((k) => this.changes.filter((c) => c.path === k));
  }

  /** Accepts pending changes. The workspace is never modified. */
  async accept(keys: readonly string[], options: ActionOptions = {}): Promise<ActionReport> {
    return this.runAction(keys, (changes, deps) => acceptMany(changes, deps, options));
  }

  /** Rejects pending changes by restoring their baselines. */
  async reject(keys: readonly string[], options: ActionOptions = {}): Promise<ActionReport> {
    return this.runAction(keys, (changes, deps) => rejectMany(changes, deps, options));
  }

  /** Reverses the most recent accept or reject. Undefined when there is nothing to undo. */
  async undo(): Promise<ActionReport | undefined> {
    return this.enqueue(async () => {
      const deps = this.actionDeps();
      if (!deps) {
        return undefined;
      }
      const report = await undoLast(deps);
      if (report) {
        this.logReport(report);
        await this.afterAction(deps.session, report);
      }
      return report;
    });
  }

  /**
   * Stops reviewing: the session is kept on disk (subject to retention) but is no longer
   * active, and no changes are listed. Files are not modified.
   */
  async endSession(): Promise<void> {
    await this.enqueue(async () => {
      this.cancelRunning();
      const ended = this.session;
      this.session = undefined;
      this.tracker = undefined;
      this.git = undefined;
      this.changes = [];
      await this.deps.sessions.setActive(undefined);
      await this.cleanUp(undefined);
      this.deps.log.info(`Ended review session ${ended?.id ?? ''}`);
      this.changeEmitter.fire([]);
    });
  }

  /**
   * Applies queued Claude Code hook events: task boundaries, pre/post edit attribution, and
   * stop notifications. Events are deleted once applied.
   */
  async ingestHookEvents(
    storageDir: string,
    isIgnored: (key: string) => Promise<boolean>,
  ): Promise<void> {
    await this.enqueue(async () => {
      const pending = await readPendingEvents(storageDir);
      if (pending.length === 0) {
        return;
      }
      this.hooksSeen = true;
      let changed = false;
      let stopped = false;
      for (const item of pending) {
        const { event } = item;
        if (isEditEvent(event)) {
          const applied = this.session
            ? await applyEditEvent(this.session, event, { isIgnored })
            : undefined;
          if (applied) {
            changed = true;
            this.pendingHints.add(applied.key);
            const abs = this.absolutePath(applied.key);
            if (abs) {
              this.tracker?.invalidate(abs);
            }
          }
        } else if (event.type === 'prompt') {
          await this.onPrompt();
        } else {
          stopped = true;
        }
        await deleteEvent(item);
      }
      if (changed && this.session) {
        await this.deps.sessions.save(this.session);
      }
      await this.refresh();
      if (stopped) {
        this.stopEmitter.fire(this.changes.length);
      }
    });
  }

  /** A new Claude Code prompt: start a fresh session when nothing is waiting for review. */
  private async onPrompt(): Promise<void> {
    const config = readConfig(this.deps.folder);
    if (!this.session) {
      if (config.autoTrack) {
        this.deps.log.info('Claude Code prompt received: starting a review session');
        await this.startSession();
      }
      return;
    }
    if (!config.newSessionPerPrompt) {
      return;
    }
    await this.refresh();
    if (this.changes.length === 0) {
      this.deps.log.info(
        'Claude Code prompt received: starting a new review session for this task',
      );
      await this.startSession();
    } else {
      this.deps.log.info(
        `Claude Code prompt received, but ${this.changes.length} changes are still pending; ` +
          'continuing the current review session so they are not hidden.',
      );
    }
  }

  private async runAction(
    keys: readonly string[],
    run: (changes: DetectedChange[], deps: ActionDeps) => Promise<ActionReport>,
  ): Promise<ActionReport> {
    return this.enqueue(async () => {
      const deps = this.actionDeps();
      const changes = this.pendingChanges(keys);
      const found = new Set(changes.map((c) => c.path));
      const missing = keys.filter((k) => !found.has(k));
      const report = deps
        ? await run(changes, deps)
        : {
            action: 'accept' as const,
            succeeded: [],
            conflicts: [],
            blocked: [],
            failed: [],
            cancelled: [],
          };
      // Keys that are no longer pending were changed or decided elsewhere since the user looked.
      report.conflicts.push(
        ...missing.map((key) => ({ key, message: 'No longer has a pending change.' })),
      );
      this.logReport(report);
      if (deps) {
        await this.afterAction(deps.session, report);
      }
      return report;
    });
  }

  private actionDeps(): ActionDeps | undefined {
    const session = this.session;
    if (!session) {
      return undefined;
    }
    const config = readConfig(this.deps.folder);
    return {
      session,
      store: this.deps.snapshots,
      git: this.git,
      sensitive: config.sensitive,
      limits: config.limits,
      removeFile: moveToTrash,
    };
  }

  private async afterAction(session: SessionData, report: ActionReport): Promise<void> {
    const problems = [...report.conflicts, ...report.blocked, ...report.failed];
    for (const p of problems) {
      session.log.push({
        at: new Date().toISOString(),
        level: 'warning',
        path: p.key,
        message: `${report.action}: ${p.message}`,
      });
    }
    await this.deps.sessions.save(session);
    for (const key of [...report.succeeded, ...problems.map((p) => p.key)]) {
      const abs = this.absolutePath(key);
      if (abs) {
        this.tracker?.invalidate(abs);
      }
    }
    await this.refresh();
  }

  private logReport(report: ActionReport): void {
    const { log } = this.deps;
    if (report.succeeded.length > 0) {
      log.info(
        `${report.action}: ${report.succeeded.length} succeeded (${report.succeeded.join(', ')})`,
      );
    }
    for (const [label, issues] of [
      ['conflict', report.conflicts],
      ['blocked', report.blocked],
      ['failed', report.failed],
    ] as const) {
      for (const issue of issues) {
        log.warn(`${report.action} ${label}: ${issue.key}: ${issue.message}`);
      }
    }
    if (report.cancelled.length > 0) {
      log.info(`${report.action}: cancelled before ${report.cancelled.length} files`);
    }
  }

  private async cleanUp(activeId: string | undefined): Promise<void> {
    try {
      const policy = readConfig(this.deps.folder).retention;
      const result = await applyRetention(
        this.deps.sessions,
        this.deps.snapshots,
        policy,
        activeId,
      );
      if (result.sessionsDeleted > 0 || result.snapshotsDeleted > 0) {
        this.deps.log.info(
          `Cleanup: removed ${result.sessionsDeleted} old sessions and ${result.snapshotsDeleted} unused snapshots`,
        );
      }
    } catch (e) {
      this.deps.log.warn(`Cleanup failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const next = this.actionQueue.then(action, action);
    this.actionQueue = next.catch(() => undefined);
    return next;
  }

  /** Loads the persisted session, or starts one when automatic tracking is enabled. */
  async initialize(): Promise<void> {
    const existing = await this.deps.sessions.loadActive();
    if (existing?.workspaceFolder === this.deps.folder.uri.fsPath) {
      await this.cleanUp(existing.id);
      await this.adopt(existing);
      this.deps.log.info(`Resumed review session ${existing.id} (${existing.mode} mode)`);
    } else if (readConfig(this.deps.folder).autoTrack) {
      await this.startSession();
    } else {
      this.deps.log.info('Automatic review tracking is disabled; no session started.');
    }
  }

  /**
   * Captures a fresh baseline of the workspace as it is right now and makes it the active
   * session. Changes from the previous session are no longer shown.
   */
  async startSession(): Promise<SessionData> {
    this.cancelRunning();
    const config = readConfig(this.deps.folder);
    const { session } = await vscode.window.withProgress(
      { location: { viewId: this.deps.viewId }, title: 'Capturing review baseline' },
      () =>
        captureBaseline(
          this.deps.folder.uri.fsPath,
          this.deps.snapshots,
          { limits: config.limits, exclude: config.exclude, sensitive: config.sensitive },
          this.deps.gitPath,
        ),
    );
    await this.deps.sessions.save(session);
    await this.deps.sessions.setActive(session.id);
    await this.cleanUp(session.id);
    const captured = Object.keys(session.baselines).length;
    this.deps.log.info(
      `Started review session ${session.id} (${session.mode} mode, root ${session.root}, ` +
        `${captured} pre-existing ${captured === 1 ? 'change' : 'changes'} captured)`,
    );
    for (const entry of session.log) {
      this.deps.log.warn(`${entry.path ?? ''}: ${entry.message}`);
    }
    await this.adopt(session);
    return session;
  }

  /** Recomputes the change list now. Resolves when the refresh (or a newer one) completes. */
  async refresh(options: { full?: boolean } = {}): Promise<void> {
    if (options.full) {
      this.pendingFull = true;
    }
    this.dirty = true;
    this.clearDebounce();
    await this.drain();
  }

  scheduleRefresh(options: { full?: boolean } = {}): void {
    if (options.full) {
      this.pendingFull = true;
    }
    this.dirty = true;
    this.clearDebounce();
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.drain();
    }, REFRESH_DEBOUNCE_MS);
  }

  private async adopt(session: SessionData): Promise<void> {
    const config = readConfig(this.deps.folder);
    const git = session.mode === 'git' ? new Git(session.root, this.deps.gitPath) : undefined;
    this.session = session;
    this.git = git;
    this.tracker = new ChangeTracker(session, git, config.exclude, config.limits);
    this.changes = [];
    await this.refresh({ full: true });
  }

  private onFileEvent(uri: vscode.Uri): void {
    const session = this.session;
    if (!session || this.disposed) {
      return;
    }
    const rel = relativeTo(session.root, uri.fsPath);
    if (rel !== undefined && !rel.startsWith('.git/')) {
      this.pendingHints.add(rel);
      this.tracker?.invalidate(uri.fsPath);
    }
    this.scheduleRefresh();
  }

  /** Runs refreshes until no work is pending. Only one refresh runs at a time. */
  private async drain(): Promise<void> {
    while (this.running) {
      await this.running;
    }
    if (this.disposed || !this.dirty || !this.tracker || !this.session) {
      return;
    }
    this.dirty = false;
    const tracker = this.tracker;
    const session = this.session;
    const hints = this.pendingHints;
    const full = this.pendingFull;
    this.pendingHints = new Set();
    this.pendingFull = false;
    this.abort = new AbortController();
    const { signal } = this.abort;

    this.running = (async () => {
      try {
        const result = await tracker.detect({ hints, full, signal });
        if (signal.aborted || this.session !== session) {
          return;
        }
        this.changes = result.changes;
        if (result.baselinesChanged) {
          await this.deps.sessions.save(session);
        }
        this.changeEmitter.fire(this.toChangedFiles());
      } catch (e) {
        if (!isAbort(e)) {
          this.deps.log.error(
            `Change detection failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    })();
    try {
      await this.running;
    } finally {
      this.running = undefined;
    }
  }

  /** Current panel entries: pending changes plus decided ones that have not changed since. */
  changedFiles(): ChangedFile[] {
    return this.toChangedFiles();
  }

  private toChangedFiles(): ChangedFile[] {
    const session = this.session;
    if (!session) {
      return [];
    }
    const toWorkspace = (p: string): string =>
      relativeTo(session.workspaceFolder, path.join(session.root, p)) ?? p;
    const files: ChangedFile[] = [];
    const pendingPaths = new Set<string>();
    for (const c of this.changes) {
      pendingPaths.add(c.path);
      if (c.oldPath !== undefined) {
        pendingPaths.add(c.oldPath);
      }
      files.push({
        key: c.path,
        path: toWorkspace(c.path),
        kind: c.kind,
        status: 'pending',
        ...(c.oldPath !== undefined ? { oldPath: toWorkspace(c.oldPath) } : {}),
        ...(c.restoreBlocker !== undefined ? { restoreBlocker: c.restoreBlocker } : {}),
        ...(c.origin !== undefined && this.hooksSeen ? { origin: c.origin } : {}),
        ...(c.restoreTarget ? { restoresPreClaudeState: true } : {}),
      });
    }
    for (const [key, record] of Object.entries(session.reviews)) {
      // A decided file that changed again is shown once, as pending.
      if (pendingPaths.has(key)) {
        continue;
      }
      files.push({
        key,
        path: toWorkspace(key),
        kind: record.kind,
        status: record.status,
        ...(record.oldPath !== undefined ? { oldPath: toWorkspace(record.oldPath) } : {}),
      });
    }
    return files;
  }

  private cancelRunning(): void {
    this.abort?.abort();
    this.clearDebounce();
  }

  private clearDebounce(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.cancelRunning();
    this.disposables.forEach((d) => {
      d.dispose();
    });
  }
}

/** Moves a file to the OS trash, falling back to deletion (its bytes are already backed up). */
async function moveToTrash(abs: string): Promise<void> {
  const uri = vscode.Uri.file(abs);
  try {
    await vscode.workspace.fs.delete(uri, { useTrash: true });
  } catch {
    await vscode.workspace.fs.delete(uri, { useTrash: false });
  }
}
