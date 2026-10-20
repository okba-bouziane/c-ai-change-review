import * as fs from 'node:fs/promises';
import type { GlobSet } from '../core/glob';
import { resolveInside } from '../core/paths';
import {
  stateToken,
  type Baseline,
  type CurrentState,
  type DetectedChange,
  type ReviewRecord,
  type SessionData,
} from '../core/session';
import type { SnapshotStore } from '../storage/snapshotStore';
import { formatBytes, type CaptureLimits } from './baseline';
import { describeError, readCurrentState, sha256 } from './fileState';
import {
  isSuccess,
  plansForChange,
  restoreGroup,
  type RestoreDeps,
  type RestoreResult,
} from './restore';

export interface AcceptDeps {
  readonly session: SessionData;
  readonly store: SnapshotStore;
  readonly sensitive: GlobSet;
  readonly limits: CaptureLimits;
}

export type AcceptResult =
  | { readonly ok: true; readonly record: ReviewRecord }
  | {
      readonly ok: false;
      readonly reason: 'conflict' | 'unsupported' | 'failed';
      readonly message: string;
    };

/**
 * Accepts a change: keeps the file exactly as it is and moves its baseline forward to the
 * reviewed content. Never writes to the workspace. Refuses if the file changed after the
 * change was detected, so the user never accepts content they have not seen.
 */
export async function acceptChange(
  change: DetectedChange,
  deps: AcceptDeps,
): Promise<AcceptResult> {
  const { session } = deps;
  try {
    const after = await captureReviewed(change.path, change.current, deps);
    if ('ok' in after) {
      return after;
    }
    let oldAfter: Baseline | undefined;
    if (change.kind === 'renamed' && change.oldPath !== undefined) {
      const oldNow = await readCurrentState(resolveInside(session.root, change.oldPath));
      if (oldNow.type !== 'absent') {
        return conflict();
      }
      oldAfter = { type: 'absent' };
    }

    const record: ReviewRecord = {
      status: 'accepted',
      kind: change.kind,
      at: new Date().toISOString(),
      before: change.baseline,
      after,
      ...(change.oldPath !== undefined ? { oldPath: change.oldPath } : {}),
      ...(change.oldBaseline ? { oldBefore: change.oldBaseline } : {}),
      ...(oldAfter ? { oldAfter } : {}),
    };
    session.baselines[change.path] = after;
    if (change.oldPath !== undefined && oldAfter) {
      session.baselines[change.oldPath] = oldAfter;
      Reflect.deleteProperty(session.reviews, change.oldPath);
    }
    session.reviews[change.path] = record;
    return { ok: true, record };
  } catch (e) {
    return { ok: false, reason: 'failed', message: describeError(e) };
  }
}

export interface RejectOutcome {
  readonly results: RestoreResult[];
  /** Present when every path was restored and the decision was recorded. */
  readonly record?: ReviewRecord;
}

/**
 * Rejects a change by restoring its baseline (see restoreGroup for the safety checks).
 * The decision is only recorded when every path of the change was restored.
 */
export async function rejectChange(
  change: DetectedChange,
  deps: RestoreDeps,
): Promise<RejectOutcome> {
  const results = await restoreGroup(plansForChange(change), deps);
  if (!results.every(isSuccess)) {
    return { results };
  }
  const isRename = change.kind === 'renamed' && change.oldPath !== undefined;
  const main = isRename ? results[1] : results[0];
  const old = isRename ? results[0] : undefined;
  const record: ReviewRecord = {
    status: 'rejected',
    kind: change.kind,
    at: new Date().toISOString(),
    before: change.baseline,
    after: main?.replaced ?? { type: 'absent' },
    ...(change.oldPath !== undefined ? { oldPath: change.oldPath } : {}),
    ...(change.oldBaseline ? { oldBefore: change.oldBaseline } : {}),
    ...(old?.replaced ? { oldAfter: old.replaced } : {}),
  };
  deps.session.reviews[change.path] = record;
  if (change.oldPath !== undefined) {
    Reflect.deleteProperty(deps.session.reviews, change.oldPath);
  }
  return { results, record };
}

/** Copies the reviewed content into the store and returns it as the new baseline. */
async function captureReviewed(
  relPath: string,
  reviewed: CurrentState,
  deps: AcceptDeps,
): Promise<Baseline | AcceptResult> {
  const abs = resolveInside(deps.session.root, relPath);
  if (reviewed.type === 'other') {
    return {
      ok: false,
      reason: 'unsupported',
      message: `It is a ${reviewed.reason}, which cannot be reviewed.`,
    };
  }
  const now = await readCurrentState(abs);
  if (stateToken(now) !== stateToken(reviewed)) {
    return conflict();
  }
  if (now.type !== 'file') {
    return { type: 'absent' };
  }

  const hashOnly = (reason: string): Baseline => ({
    type: 'unavailable',
    reason,
    hash: now.hash,
    size: now.size,
  });
  if (deps.sensitive.matches(relPath)) {
    return hashOnly('matches a sensitive-file pattern, so its content was not copied');
  }
  if (now.size > deps.limits.maxFileSize) {
    return hashOnly(`larger than the ${formatBytes(deps.limits.maxFileSize)} snapshot limit`);
  }
  const bytes = await fs.readFile(abs);
  if (sha256(bytes) !== now.hash) {
    return conflict();
  }
  const hash = await deps.store.put(bytes);
  return { type: 'stored', hash, size: bytes.length, mode: now.mode };
}

function conflict(): AcceptResult {
  return {
    ok: false,
    reason: 'conflict',
    message: 'The file changed after it was reviewed. Review the latest version before accepting.',
  };
}
