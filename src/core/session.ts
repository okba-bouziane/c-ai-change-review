import type { ChangeKind } from './types';

/** Lowercase hex SHA-256 of a file's exact bytes. */
export type Sha256 = string;

/**
 * What a path looked like at the review baseline.
 *
 * - absent: the path did not exist.
 * - stored: exact bytes are in the snapshot store under `hash`.
 * - git: bytes equal the Git blob checked out through the repository's filters
 *   (used for files that were clean at the baseline, so nothing is copied).
 * - unavailable: the path existed but its bytes were deliberately not kept (too large,
 *   sensitive, symlink, unreadable). `hash` is present when it could still be measured,
 *   which lets change detection work even though restore cannot.
 */
export type Baseline =
  | { readonly type: 'absent' }
  | { readonly type: 'stored'; readonly hash: Sha256; readonly size: number; readonly mode: number }
  | {
      readonly type: 'git';
      readonly blob: string;
      readonly mode: number;
      /** Filled in once the filtered blob has been hashed. */
      readonly hash?: Sha256;
      readonly size?: number;
    }
  | {
      readonly type: 'unavailable';
      readonly reason: string;
      readonly hash?: Sha256;
      readonly size?: number;
    };

/** What a path looks like on disk right now. */
export type CurrentState =
  | { readonly type: 'absent' }
  | { readonly type: 'file'; readonly hash: Sha256; readonly size: number; readonly mode: number }
  /** Exists but is not a regular file we can read and hash (directory, symlink, EACCES...). */
  | { readonly type: 'other'; readonly reason: string };

export type SessionMode = 'git' | 'filesystem';

export interface SessionData {
  readonly version: 1;
  readonly id: string;
  readonly createdAt: string;
  /** Absolute path of the VS Code workspace folder this session belongs to. */
  readonly workspaceFolder: string;
  /** Absolute session root: the Git top-level, or the workspace folder in filesystem mode. */
  readonly root: string;
  /** Root-relative path of the workspace folder inside root ('' when they are the same). */
  readonly scope: string;
  readonly mode: SessionMode;
  /** HEAD commit at the baseline, or null for an unborn branch / filesystem mode. */
  readonly head: string | null;
  /**
   * Explicit baselines keyed by root-relative path. In Git mode this holds every path that
   * was dirty, staged, or untracked at the baseline, plus clean files resolved lazily from
   * HEAD. In filesystem mode it holds every file that existed at the baseline.
   */
  readonly baselines: Record<string, Baseline>;
  /** Problems worth surfacing later (capture skipped files, restore conflicts, ...). */
  readonly log: SessionLogEntry[];
  /** Review decisions keyed by root-relative path (the new path for renames). */
  readonly reviews: Record<string, ReviewRecord>;
  /** Review actions that can be undone, oldest first. */
  readonly history: HistoryEntry[];
  /**
   * Edits made through Claude Code's file tools, reported by the optional hooks and keyed by
   * root-relative path. Absent for paths Claude has not edited (or when hooks are off).
   */
  readonly attribution: Record<string, Attribution>;
}

/**
 * What the hooks observed about Claude Code editing one path during this session.
 *
 * `before` is the file as it was immediately before Claude's first edit, captured by the
 * PreToolUse hook. When it differs from the session baseline, the difference was made by
 * someone else (the user, a formatter, a Bash command) before Claude touched the file, and
 * rejecting restores `before` so that work survives.
 */
export interface Attribution {
  readonly before: Baseline;
  /** stateToken()-style token of the file right after Claude's most recent edit. */
  readonly afterToken?: string;
  readonly claudeSessionId?: string;
  readonly at: string;
}

/** How a detected change relates to Claude Code's own edits. */
export type ChangeOrigin =
  /** The file is exactly as Claude's last edit left it. */
  | 'claude'
  /** Claude edited the file, and it changed again afterwards. */
  | 'claude-then-other'
  /** No Claude edit was reported for this file (Bash, formatters, user, or hooks off). */
  | 'unattributed';

/** One undoable user action: a single decision or a whole Accept All / Reject All. */
export interface HistoryEntry {
  readonly id: string;
  readonly at: string;
  readonly action: 'accept' | 'reject';
  readonly items: HistoryItem[];
}

export interface HistoryItem {
  readonly key: string;
  readonly record: ReviewRecord;
  /** The decision this one replaced, restored on undo. */
  readonly previous?: ReviewRecord;
  /** For renames: the decision recorded on the old path, if any. */
  readonly oldPrevious?: ReviewRecord;
  /** Hook attribution the action cleared, restored on undo. */
  readonly attribution?: Attribution;
}

/**
 * A decision the user made about one change.
 *
 * Accepting moves the file's baseline forward to the accepted content, so later edits show
 * up as a new pending change. Rejecting writes the baseline back and keeps a backup of the
 * rejected content. `before`/`after` keep enough to show the decision as a diff and, later,
 * to undo it.
 */
export interface ReviewRecord {
  readonly status: 'accepted' | 'rejected';
  readonly kind: ChangeKind;
  readonly oldPath?: string;
  readonly at: string;
  /** The path's baseline before the decision (the original content). */
  readonly before: Baseline;
  /** Accepted: the new baseline. Rejected: backup of the content that was thrown away. */
  readonly after: Baseline;
  /** Same as before/after for the rename source path. */
  readonly oldBefore?: Baseline;
  readonly oldAfter?: Baseline;
}

export interface SessionLogEntry {
  readonly at: string;
  readonly level: 'info' | 'warning' | 'error';
  readonly path?: string;
  readonly message: string;
}

/** A detected difference between a path's baseline and its current state. */
export interface DetectedChange {
  readonly path: string;
  readonly kind: ChangeKind;
  /** Rename source, when kind === 'renamed'. */
  readonly oldPath?: string;
  readonly baseline: Baseline;
  /** Baseline of oldPath for renames. */
  readonly oldBaseline?: Baseline;
  readonly current: CurrentState;
  /** Why this change cannot be rejected automatically, if it cannot. */
  readonly restoreBlocker?: string;
  readonly origin?: ChangeOrigin;
  /**
   * What Reject writes back when it is not the baseline: the file as it was right before
   * Claude first edited it, when that already contained other changes.
   */
  readonly restoreTarget?: Baseline;
}

export function baselineHash(b: Baseline): Sha256 | undefined {
  return b.type === 'absent' ? undefined : b.hash;
}

export function baselineExists(b: Baseline): boolean {
  return b.type !== 'absent';
}

/** Hash of the current state used for optimistic concurrency checks ('absent' when missing). */
export function stateToken(s: CurrentState): string {
  switch (s.type) {
    case 'absent':
      return 'absent';
    case 'file':
      return `file:${s.hash}:${s.mode.toString(8)}`;
    case 'other':
      return `other:${s.reason}`;
  }
}

/**
 * Compares a baseline with the current state.
 * Returns the change kind, or undefined when the path is unchanged.
 */
export function classify(baseline: Baseline, current: CurrentState): ChangeKind | undefined {
  const existedBefore = baselineExists(baseline);
  if (current.type === 'absent') {
    return existedBefore ? 'deleted' : undefined;
  }
  if (!existedBefore) {
    return 'added';
  }
  if (current.type === 'other') {
    return 'modified';
  }
  const before = baselineHash(baseline);
  if (before === undefined || before !== current.hash) {
    return 'modified';
  }
  // Same bytes; an executable-bit flip still counts as a change worth reviewing.
  const beforeMode =
    baseline.type === 'stored' || baseline.type === 'git' ? baseline.mode : undefined;
  if (beforeMode !== undefined && (beforeMode & 0o111) !== (current.mode & 0o111)) {
    return 'modified';
  }
  return undefined;
}

/** Why a baseline cannot be written back, or undefined when it can. */
export function restoreBlocker(b: Baseline): string | undefined {
  return b.type === 'unavailable' ? `Original content was not captured: ${b.reason}` : undefined;
}

/**
 * Pairs deletions with additions of identical content into renames. A pair is only formed
 * when the content hash identifies exactly one deleted and one added file, so ambiguous
 * cases (several copies of the same file) stay as separate add/delete entries.
 */
export function pairRenames(changes: readonly DetectedChange[]): DetectedChange[] {
  const deletedByHash = new Map<Sha256, DetectedChange[]>();
  const addedByHash = new Map<Sha256, DetectedChange[]>();
  for (const c of changes) {
    if (c.kind === 'deleted') {
      const h = baselineHash(c.baseline);
      if (h !== undefined && c.baseline.type !== 'unavailable') {
        push(deletedByHash, h, c);
      }
    } else if (c.kind === 'added' && c.current.type === 'file') {
      push(addedByHash, c.current.hash, c);
    }
  }

  const consumed = new Set<DetectedChange>();
  const renames: DetectedChange[] = [];
  for (const [hash, deleted] of deletedByHash) {
    const added = addedByHash.get(hash);
    const [del] = deleted;
    const [add] = added ?? [];
    if (deleted.length === 1 && added?.length === 1 && del && add) {
      consumed.add(del).add(add);
      renames.push({
        path: add.path,
        kind: 'renamed',
        oldPath: del.path,
        baseline: add.baseline,
        oldBaseline: del.baseline,
        current: add.current,
        ...withBlocker(del.restoreBlocker ?? add.restoreBlocker),
      });
    }
  }
  return [...changes.filter((c) => !consumed.has(c)), ...renames];
}

export function withBlocker(blocker: string | undefined): { restoreBlocker?: string } {
  return blocker === undefined ? {} : { restoreBlocker: blocker };
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) {
    list.push(value);
  } else {
    map.set(key, [value]);
  }
}

/**
 * The stateToken() a file has when it matches this baseline, or undefined when the baseline's
 * bytes are unknown (so a file cannot be verified against it).
 */
export function baselineToken(b: Baseline): string | undefined {
  switch (b.type) {
    case 'absent':
      return 'absent';
    case 'stored':
      return `file:${b.hash}:${b.mode.toString(8)}`;
    case 'git':
      return b.hash === undefined ? undefined : `file:${b.hash}:${b.mode.toString(8)}`;
    case 'unavailable':
      return undefined;
  }
}

/** Every snapshot-store hash a session still needs. */
export function referencedHashes(session: SessionData): Set<Sha256> {
  const hashes = new Set<Sha256>();
  const add = (b: Baseline | undefined): void => {
    if (b?.type === 'stored') {
      hashes.add(b.hash);
    }
  };
  const addRecord = (r: ReviewRecord | undefined): void => {
    if (r) {
      add(r.before);
      add(r.after);
      add(r.oldBefore);
      add(r.oldAfter);
    }
  };
  Object.values(session.baselines).forEach(add);
  Object.values(session.attribution).forEach((a) => {
    add(a.before);
  });
  Object.values(session.reviews).forEach(addRecord);
  for (const entry of session.history) {
    for (const item of entry.items) {
      addRecord(item.record);
      addRecord(item.previous);
      addRecord(item.oldPrevious);
    }
  }
  return hashes;
}

/**
 * Applies hook attribution to a detected change: labels its origin and, when Claude's
 * pre-edit snapshot differs from the baseline, makes Reject restore that snapshot instead.
 */
export function attribute(change: DetectedChange, a: Attribution | undefined): DetectedChange {
  if (!a || change.kind === 'renamed') {
    return { ...change, origin: 'unattributed' };
  }
  const origin: ChangeOrigin =
    a.afterToken !== undefined && a.afterToken === stateToken(change.current)
      ? 'claude'
      : 'claude-then-other';
  const beforeToken = baselineToken(a.before);
  const differsFromBaseline =
    beforeToken === undefined || beforeToken !== baselineToken(change.baseline);
  if (!differsFromBaseline || a.before.type === 'unavailable') {
    return { ...change, origin };
  }
  // Rejecting removes only what happened from Claude's first edit onwards.
  const { restoreBlocker, ...rest } = change;
  return { ...rest, origin, restoreTarget: a.before };
}
