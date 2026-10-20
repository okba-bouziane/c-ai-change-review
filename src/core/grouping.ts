import { CHANGE_KIND_ORDER, type ChangeKind, type ChangedFile, type ReviewStatus } from './types';

export interface ChangeGroup {
  readonly kind: ChangeKind;
  readonly files: readonly ChangedFile[];
}

export type StatusFilter = ReadonlySet<ReviewStatus>;

export const ALL_STATUSES: StatusFilter = new Set<ReviewStatus>([
  'pending',
  'accepted',
  'rejected',
]);

/**
 * Groups files by change kind in a fixed display order, sorting each group by path.
 * Empty groups are omitted so the tree never shows a header with nothing under it.
 */
export function groupChanges(
  files: readonly ChangedFile[],
  filter: StatusFilter = ALL_STATUSES,
): ChangeGroup[] {
  const byKind = new Map<ChangeKind, ChangedFile[]>();
  for (const file of files) {
    if (!filter.has(file.status)) {
      continue;
    }
    let bucket = byKind.get(file.kind);
    if (!bucket) {
      bucket = [];
      byKind.set(file.kind, bucket);
    }
    bucket.push(file);
  }

  const groups: ChangeGroup[] = [];
  for (const kind of CHANGE_KIND_ORDER) {
    const bucket = byKind.get(kind);
    if (bucket && bucket.length > 0) {
      bucket.sort((a, b) => comparePaths(a.path, b.path));
      groups.push({ kind, files: bucket });
    }
  }
  return groups;
}

export function countByStatus(files: readonly ChangedFile[]): Record<ReviewStatus, number> {
  const counts: Record<ReviewStatus, number> = { pending: 0, accepted: 0, rejected: 0 };
  for (const file of files) {
    counts[file.status]++;
  }
  return counts;
}

/** Splits a workspace-relative path into its file name and parent directory ('' at the root). */
export function splitPath(path: string): { name: string; dir: string } {
  const slash = path.lastIndexOf('/');
  return slash === -1
    ? { name: path, dir: '' }
    : { name: path.slice(slash + 1), dir: path.slice(0, slash) };
}

function comparePaths(a: string, b: string): number {
  // Code-unit ordering is deterministic across locales, which keeps tests and the UI stable.
  return a < b ? -1 : a > b ? 1 : 0;
}
