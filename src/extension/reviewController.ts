import * as path from 'node:path';
import * as vscode from 'vscode';
import { relativeTo } from '../core/paths';
import type { DetectedChange, SessionData } from '../core/session';
import type { ChangedFile } from '../core/types';
import { captureBaseline } from '../services/baseline';
import { ChangeTracker } from '../services/changeTracker';
import { isAbort } from '../services/fileState';
import { Git } from '../services/git';
import type { SessionStore } from '../storage/sessionStore';
import type { SnapshotStore } from '../storage/snapshotStore';
import { readConfig, SECTION } from './config';

const REFRESH_DEBOUNCE_MS = 300;

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
  /** Fires with the latest change list after every successful refresh. */
  readonly onDidChange = this.changeEmitter.event;

  private readonly disposables: vscode.Disposable[] = [this.changeEmitter];
  private session: SessionData | undefined;
  private tracker: ChangeTracker | undefined;
  private changes: DetectedChange[] = [];

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

  /** Loads the persisted session, or starts one when automatic tracking is enabled. */
  async initialize(): Promise<void> {
    const existing = await this.deps.sessions.loadActive();
    if (existing?.workspaceFolder === this.deps.folder.uri.fsPath) {
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
        this.changeEmitter.fire(this.toChangedFiles(result.changes));
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

  private toChangedFiles(changes: readonly DetectedChange[]): ChangedFile[] {
    const session = this.session;
    if (!session) {
      return [];
    }
    const toWorkspace = (p: string): string =>
      relativeTo(session.workspaceFolder, path.join(session.root, p)) ?? p;
    return changes.map((c) => ({
      path: toWorkspace(c.path),
      kind: c.kind,
      status: 'pending',
      ...(c.oldPath !== undefined ? { oldPath: toWorkspace(c.oldPath) } : {}),
      ...(c.restoreBlocker !== undefined ? { restoreBlocker: c.restoreBlocker } : {}),
    }));
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
