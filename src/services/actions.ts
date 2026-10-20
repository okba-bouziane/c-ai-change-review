import { randomUUID } from 'node:crypto';
import {
  baselineToken,
  type DetectedChange,
  type HistoryEntry,
  type HistoryItem,
  type ReviewRecord,
  type SessionData,
} from '../core/session';
import type { GlobSet } from '../core/glob';
import type { SnapshotStore } from '../storage/snapshotStore';
import type { CaptureLimits } from './baseline';
import type { Git } from './git';
import { restoreGroup, type RestorePlan, type RestoreResult } from './restore';
import { acceptChange, rejectChange } from './review';

/** Oldest undo entries are dropped beyond this. */
export const MAX_HISTORY = 50;

export interface ActionDeps {
  readonly session: SessionData;
  readonly store: SnapshotStore;
  readonly git: Git | undefined;
  readonly sensitive: GlobSet;
  readonly limits: CaptureLimits;
  readonly removeFile?: (abs: string) => Promise<void>;
}

export interface ActionOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (done: number, total: number, key: string) => void;
}

export interface Issue {
  readonly key: string;
  readonly message: string;
}

/**
 * The outcome of an action over one or more files. Every requested file appears in exactly
 * one list, so callers can report precisely what happened and never overstate success.
 */
export interface ActionReport {
  readonly action: 'accept' | 'reject' | 'undo';
  readonly succeeded: string[];
  /** Changed since it was reviewed; nothing written. */
  readonly conflicts: Issue[];
  /** Cannot be done safely (no original bytes, unsafe path, ...); nothing written. */
  readonly blocked: Issue[];
  /** I/O error; for renames some paths may have been written (see message). */
  readonly failed: Issue[];
  /** Not attempted because the operation was cancelled. */
  readonly cancelled: string[];
}

export function isCompleteSuccess(r: ActionReport): boolean {
  return (
    r.conflicts.length === 0 &&
    r.blocked.length === 0 &&
    r.failed.length === 0 &&
    r.cancelled.length === 0
  );
}

function emptyReport(action: ActionReport['action']): ActionReport {
  return { action, succeeded: [], conflicts: [], blocked: [], failed: [], cancelled: [] };
}

/** Accepts each change. Workspace files are never modified. */
export async function acceptMany(
  changes: readonly DetectedChange[],
  deps: ActionDeps,
  options: ActionOptions = {},
): Promise<ActionReport> {
  const report = emptyReport('accept');
  const items: HistoryItem[] = [];
  for (const [i, change] of changes.entries()) {
    if (options.signal?.aborted) {
      report.cancelled.push(...changes.slice(i).map((c) => c.path));
      break;
    }
    options.onProgress?.(i, changes.length, change.path);
    const previous = snapshotPrevious(deps.session, change);
    const result = await acceptChange(change, deps);
    if (result.ok) {
      report.succeeded.push(change.path);
      items.push({ key: change.path, record: result.record, ...previous });
    } else {
      const issue = { key: change.path, message: result.message };
      (result.reason === 'conflict'
        ? report.conflicts
        : result.reason === 'unsupported'
          ? report.blocked
          : report.failed
      ).push(issue);
    }
  }
  pushHistory(deps.session, 'accept', items);
  return report;
}

/** Rejects each change through the safe restore engine. */
export async function rejectMany(
  changes: readonly DetectedChange[],
  deps: ActionDeps,
  options: ActionOptions = {},
): Promise<ActionReport> {
  const report = emptyReport('reject');
  const items: HistoryItem[] = [];
  for (const [i, change] of changes.entries()) {
    if (options.signal?.aborted) {
      report.cancelled.push(...changes.slice(i).map((c) => c.path));
      break;
    }
    options.onProgress?.(i, changes.length, change.path);
    if (change.restoreBlocker !== undefined) {
      report.blocked.push({ key: change.path, message: change.restoreBlocker });
      continue;
    }
    const previous = snapshotPrevious(deps.session, change);
    const outcome = await rejectChange(change, deps);
    if (outcome.record) {
      report.succeeded.push(change.path);
      items.push({ key: change.path, record: outcome.record, ...previous });
    } else {
      classifyFailure(report, change.path, outcome.results);
    }
  }
  pushHistory(deps.session, 'reject', items);
  return report;
}

/**
 * Reverses the most recent action.
 *
 * Undoing an accept only moves baselines back (no file is touched), so the files show as
 * pending again. Undoing a reject writes the rejected content back, but only if each file
 * is still exactly as the reject left it; otherwise that file is reported as a conflict and
 * stays on the undo stack.
 */
export async function undoLast(deps: ActionDeps): Promise<ActionReport | undefined> {
  const { session } = deps;
  const entry = session.history.pop();
  if (!entry) {
    return undefined;
  }
  const report = emptyReport('undo');
  const remaining: HistoryItem[] = [];

  for (const item of [...entry.items].reverse()) {
    if (entry.action === 'accept') {
      undoAccept(session, item);
      report.succeeded.push(item.key);
      continue;
    }
    const results = await restoreGroup(undoRejectPlans(item.record, item.key), deps);
    if (
      results.every(
        (r) => r.outcome === 'restored' || r.outcome === 'removed' || r.outcome === 'unchanged',
      )
    ) {
      restorePrevious(session, item);
      report.succeeded.push(item.key);
    } else {
      classifyFailure(report, item.key, results);
      remaining.unshift(item);
    }
  }
  if (remaining.length > 0) {
    session.history.push({ ...entry, items: remaining });
  }
  return report;
}

/** Restore plans that put back what a reject replaced, guarded by what the reject wrote. */
export function undoRejectPlans(record: ReviewRecord, key: string): RestorePlan[] {
  const plans: RestorePlan[] = [
    { path: key, baseline: record.after, expected: baselineToken(record.before) ?? 'unknown' },
  ];
  if (record.oldPath !== undefined && record.oldBefore) {
    plans.push({
      path: record.oldPath,
      baseline: record.oldAfter ?? { type: 'absent' },
      expected: baselineToken(record.oldBefore) ?? 'unknown',
    });
  }
  return plans;
}

function undoAccept(session: SessionData, item: HistoryItem): void {
  const { record } = item;
  session.baselines[item.key] = record.before;
  if (record.oldPath !== undefined && record.oldBefore) {
    session.baselines[record.oldPath] = record.oldBefore;
  }
  restorePrevious(session, item);
}

function restorePrevious(session: SessionData, item: HistoryItem): void {
  if (item.previous) {
    session.reviews[item.key] = item.previous;
  } else {
    Reflect.deleteProperty(session.reviews, item.key);
  }
  const oldPath = item.record.oldPath;
  if (oldPath !== undefined && item.oldPrevious) {
    session.reviews[oldPath] = item.oldPrevious;
  }
}

function snapshotPrevious(
  session: SessionData,
  change: DetectedChange,
): { previous?: ReviewRecord; oldPrevious?: ReviewRecord } {
  const previous = session.reviews[change.path];
  const oldPrevious = change.oldPath !== undefined ? session.reviews[change.oldPath] : undefined;
  return { ...(previous ? { previous } : {}), ...(oldPrevious ? { oldPrevious } : {}) };
}

function pushHistory(
  session: SessionData,
  action: HistoryEntry['action'],
  items: HistoryItem[],
): void {
  if (items.length === 0) {
    return;
  }
  session.history.push({ id: randomUUID(), at: new Date().toISOString(), action, items });
  if (session.history.length > MAX_HISTORY) {
    session.history.splice(0, session.history.length - MAX_HISTORY);
  }
}

function classifyFailure(
  report: ActionReport,
  key: string,
  results: readonly RestoreResult[],
): void {
  const written = results.filter((r) => r.outcome === 'restored' || r.outcome === 'removed');
  const problems = results.filter((r) => ['conflict', 'blocked', 'failed'].includes(r.outcome));
  const message = problems.map((r) => `${r.path}: ${r.message ?? r.outcome}`).join('; ');
  if (written.length > 0 || problems.some((r) => r.outcome === 'failed')) {
    const done =
      written.length > 0 ? ` Already written: ${written.map((r) => r.path).join(', ')}.` : '';
    report.failed.push({ key, message: message + done });
  } else if (problems.some((r) => r.outcome === 'conflict')) {
    report.conflicts.push({ key, message });
  } else {
    report.blocked.push({ key, message });
  }
}
