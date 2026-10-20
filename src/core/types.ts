// Domain types shared by every layer. Nothing in src/core may import 'vscode',
// so this logic stays unit-testable in plain Node.

export type ChangeKind = 'added' | 'modified' | 'deleted' | 'renamed';

export type ReviewStatus = 'pending' | 'accepted' | 'rejected';

export interface ChangedFile {
  /** Workspace-relative path using forward slashes. For renames, the new path. */
  readonly path: string;
  /** For renames only: the workspace-relative path before the rename. */
  readonly oldPath?: string;
  readonly kind: ChangeKind;
  readonly status: ReviewStatus;
}

export const CHANGE_KIND_ORDER: readonly ChangeKind[] = ['added', 'modified', 'deleted', 'renamed'];

export const CHANGE_KIND_LABEL: Readonly<Record<ChangeKind, string>> = {
  added: 'Added',
  modified: 'Modified',
  deleted: 'Deleted',
  renamed: 'Renamed',
};

export const REVIEW_STATUS_LABEL: Readonly<Record<ReviewStatus, string>> = {
  pending: 'Pending',
  accepted: 'Accepted',
  rejected: 'Rejected',
};
