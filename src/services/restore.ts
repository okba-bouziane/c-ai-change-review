import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { inScope, isInside, resolveInside, UnsafePathError } from '../core/paths';
import {
  restoreBlocker,
  stateToken,
  type Baseline,
  type CurrentState,
  type DetectedChange,
  type SessionData,
} from '../core/session';
import type { SnapshotStore } from '../storage/snapshotStore';
import { describeError, isNotFound, readCurrentState, sha256 } from './fileState';
import type { Git } from './git';

export interface RestoreDeps {
  readonly session: SessionData;
  readonly store: SnapshotStore;
  readonly git: Git | undefined;
  /**
   * Removes a file that did not exist at the baseline. The VS Code layer moves it to the
   * OS trash; tests delete it. The bytes are always backed up to the store first.
   */
  readonly removeFile?: (abs: string) => Promise<void>;
}

/** One path to put back into its baseline state, guarded by the state the user reviewed. */
export interface RestorePlan {
  readonly path: string;
  readonly baseline: Baseline;
  /** stateToken() of the content the user saw. Restore refuses if the file differs now. */
  readonly expected: string;
}

export type RestoreOutcome =
  | 'restored' // baseline bytes written
  | 'removed' // file deleted because it did not exist at the baseline
  | 'unchanged' // already in the baseline state
  | 'conflict' // changed since it was reviewed; nothing written
  | 'blocked' // cannot be restored safely (no baseline bytes, unsafe path, ...)
  | 'skipped' // not attempted because another path of the same change failed checks
  | 'failed'; // an I/O error happened while writing

export interface RestoreResult {
  readonly path: string;
  readonly outcome: RestoreOutcome;
  readonly message?: string;
  /** Snapshot of the bytes that were replaced or removed, so the action can be undone. */
  readonly replaced?: Baseline;
}

export function isSuccess(r: RestoreResult): boolean {
  return r.outcome === 'restored' || r.outcome === 'removed' || r.outcome === 'unchanged';
}

/** Restore plans that reject one detected change (two paths for a rename). */
export function plansForChange(change: DetectedChange): RestorePlan[] {
  const expected = stateToken(change.current);
  if (change.kind === 'renamed' && change.oldPath !== undefined && change.oldBaseline) {
    return [
      { path: change.oldPath, baseline: change.oldBaseline, expected: 'absent' },
      { path: change.path, baseline: change.baseline, expected },
    ];
  }
  return [{ path: change.path, baseline: change.restoreTarget ?? change.baseline, expected }];
}

/**
 * Restores a group of paths that belong together (one change). Every path is verified
 * first; if any check fails, nothing in the group is written. Each write is then guarded
 * again immediately before it happens, written to a temporary file in the same directory,
 * and moved into place atomically.
 */
export async function restoreGroup(
  plans: readonly RestorePlan[],
  deps: RestoreDeps,
): Promise<RestoreResult[]> {
  const prepared: Prepared[] = [];
  const failures = new Map<string, RestoreResult>();

  for (const plan of plans) {
    const check = await prepare(plan, deps);
    if ('outcome' in check) {
      failures.set(plan.path, check);
    } else {
      prepared.push(check);
    }
  }
  if (failures.size > 0) {
    return plans.map(
      (p) =>
        failures.get(p.path) ?? {
          path: p.path,
          outcome: 'skipped',
          message: 'Not restored because another part of this change could not be restored safely.',
        },
    );
  }

  const results: RestoreResult[] = [];
  for (const item of prepared) {
    results.push(await execute(item, deps));
  }
  return results;
}

interface Prepared {
  readonly plan: RestorePlan;
  readonly abs: string;
  readonly current: CurrentState;
  /** Bytes to write, or undefined to remove the file. */
  readonly content: Buffer | undefined;
  readonly mode: number;
}

async function prepare(plan: RestorePlan, deps: RestoreDeps): Promise<Prepared | RestoreResult> {
  const { session } = deps;
  const blocked = (message: string): RestoreResult => ({
    path: plan.path,
    outcome: 'blocked',
    message,
  });

  let abs: string;
  try {
    if (!inScope(session.scope, plan.path)) {
      return blocked('Path is outside the workspace folder of this review session.');
    }
    abs = resolveInside(session.root, plan.path);
    await assertNoSymlinkEscape(session.root, abs);
  } catch (e) {
    return blocked(e instanceof Error ? e.message : String(e));
  }

  const blocker = restoreBlocker(plan.baseline);
  if (blocker !== undefined) {
    return blocked(blocker);
  }

  const current = await readCurrentState(abs);
  if (current.type === 'other') {
    return blocked(`The path is currently a ${current.reason}; it will not be replaced.`);
  }

  let content: Buffer | undefined;
  let mode = 0o644;
  try {
    const loaded = await loadBaseline(plan, deps);
    content = loaded?.content;
    mode = loaded?.mode ?? mode;
  } catch (e) {
    return blocked(`Original content could not be loaded: ${describeError(e)}`);
  }

  const target = content === undefined ? 'absent' : `file:${sha256(content)}:${mode.toString(8)}`;
  if (stateToken(current) === target || (content === undefined && current.type === 'absent')) {
    return { path: plan.path, outcome: 'unchanged' };
  }
  if (stateToken(current) !== plan.expected) {
    return {
      path: plan.path,
      outcome: 'conflict',
      message:
        'The file changed after it was reviewed. Review the latest version before rejecting.',
    };
  }
  return { plan, abs, current, content, mode };
}

async function loadBaseline(
  plan: RestorePlan,
  deps: RestoreDeps,
): Promise<{ content: Buffer; mode: number } | undefined> {
  const b = plan.baseline;
  const content = await readBaselineBytes(b, plan.path, deps.store, deps.git);
  if (content === undefined || b.type === 'absent' || b.type === 'unavailable') {
    return undefined;
  }
  return { content, mode: b.mode };
}

/**
 * The exact bytes of a baseline, verified against its recorded hash.
 * Returns undefined for 'absent'; throws for 'unavailable' or when verification fails.
 */
export async function readBaselineBytes(
  b: Baseline,
  relPath: string,
  store: SnapshotStore,
  git: Git | undefined,
): Promise<Buffer | undefined> {
  switch (b.type) {
    case 'absent':
      return undefined;
    case 'stored':
      return store.get(b.hash);
    case 'git': {
      if (!git) {
        throw new Error('Git is not available');
      }
      const content = await git.readBlobFiltered(b.blob, relPath);
      if (b.hash !== undefined && sha256(content) !== b.hash) {
        throw new Error('Git returned different content than was recorded at the baseline');
      }
      return content;
    }
    case 'unavailable':
      throw new Error(b.reason);
  }
}

async function execute(item: Prepared, deps: RestoreDeps): Promise<RestoreResult> {
  const { plan, abs, current, content, mode } = item;
  let replaced: Baseline | undefined;
  try {
    // Back up what is about to be overwritten so the action can be undone.
    if (current.type === 'file') {
      const bytes = await fs.readFile(abs);
      const hash = await deps.store.put(bytes);
      if (hash !== current.hash) {
        return conflict(plan.path);
      }
      replaced = { type: 'stored', hash, size: bytes.length, mode: current.mode };
    } else {
      replaced = { type: 'absent' };
    }

    if (content === undefined) {
      if (!(await stillMatches(abs, plan.expected))) {
        return conflict(plan.path);
      }
      await (deps.removeFile ?? defaultRemove)(abs);
      return { path: plan.path, outcome: 'removed', replaced };
    }

    await ensureParentDir(deps.session.root, abs);
    const temp = path.join(
      path.dirname(abs),
      `.${path.basename(abs)}.claude-review-${randomBytes(4).toString('hex')}.tmp`,
    );
    try {
      await fs.writeFile(temp, content, { flag: 'wx', mode });
      await fs.chmod(temp, mode);
      if (!(await stillMatches(abs, plan.expected))) {
        return conflict(plan.path);
      }
      await fs.rename(temp, abs);
    } finally {
      await fs.rm(temp, { force: true });
    }
    return { path: plan.path, outcome: 'restored', replaced };
  } catch (e) {
    return {
      path: plan.path,
      outcome: 'failed',
      message: describeError(e),
      ...(replaced ? { replaced } : {}),
    };
  }
}

async function stillMatches(abs: string, expected: string): Promise<boolean> {
  return stateToken(await readCurrentState(abs)) === expected;
}

function conflict(relPath: string): RestoreResult {
  return {
    path: relPath,
    outcome: 'conflict',
    message: 'The file changed while it was being restored. Nothing was written.',
  };
}

async function defaultRemove(abs: string): Promise<void> {
  await fs.unlink(abs);
}

/**
 * Throws if the nearest existing ancestor of abs resolves (through symlinks) to somewhere
 * outside root, or if abs itself is a symlink. Prevents writes escaping the workspace.
 */
export async function assertNoSymlinkEscape(root: string, abs: string): Promise<void> {
  const realRoot = await fs.realpath(root);
  try {
    if ((await fs.lstat(abs)).isSymbolicLink()) {
      throw new UnsafePathError(path.relative(root, abs), 'the file is a symbolic link');
    }
  } catch (e) {
    if (!isNotFound(e)) {
      throw e;
    }
  }
  let dir = path.dirname(abs);
  for (;;) {
    try {
      const real = await fs.realpath(dir);
      if (!isInside(realRoot, real)) {
        throw new UnsafePathError(
          path.relative(root, abs),
          'a parent folder links outside the workspace',
        );
      }
      return;
    } catch (e) {
      if (!isNotFound(e)) {
        throw e;
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        return;
      }
      dir = parent;
    }
  }
}

async function ensureParentDir(root: string, abs: string): Promise<void> {
  await fs.mkdir(path.dirname(abs), { recursive: true });
  // Re-check after creating directories in case something raced a symlink into place.
  await assertNoSymlinkEscape(root, abs);
}
