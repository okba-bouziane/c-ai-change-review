import { referencedHashes } from '../core/session';
import type { SessionStore } from './sessionStore';
import type { SnapshotStore } from './snapshotStore';

export interface RetentionPolicy {
  /** Ended sessions kept besides the active one. */
  readonly maxSessions: number;
  /** Ended sessions older than this are deleted. */
  readonly maxAgeDays: number;
}

export interface RetentionResult {
  readonly sessionsDeleted: number;
  readonly snapshotsDeleted: number;
}

/**
 * Deletes old ended sessions, then deletes snapshot blobs that no remaining session
 * references. The active session is never deleted.
 */
export async function applyRetention(
  sessions: SessionStore,
  snapshots: SnapshotStore,
  policy: RetentionPolicy,
  activeId: string | undefined,
  now = Date.now(),
): Promise<RetentionResult> {
  const all = await sessions.list();
  const ended = all
    .filter((s) => s.id !== activeId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const cutoff = now - policy.maxAgeDays * 24 * 60 * 60 * 1000;

  let sessionsDeleted = 0;
  const kept = all.filter((s) => s.id === activeId);
  for (const [index, session] of ended.entries()) {
    if (index >= policy.maxSessions || Date.parse(session.createdAt) < cutoff) {
      await sessions.delete(session.id);
      sessionsDeleted++;
    } else {
      kept.push(session);
    }
  }

  const keep = new Set<string>();
  for (const session of kept) {
    referencedHashes(session).forEach((h) => keep.add(h));
  }
  const snapshotsDeleted = await snapshots.collectGarbage(keep);
  return { sessionsDeleted, snapshotsDeleted };
}
