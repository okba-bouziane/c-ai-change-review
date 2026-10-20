import * as vscode from 'vscode';
import { countByStatus, groupChanges, splitPath, type ChangeGroup } from '../core/grouping';
import {
  CHANGE_KIND_LABEL,
  REVIEW_STATUS_LABEL,
  type ChangeKind,
  type ChangedFile,
  type ReviewStatus,
} from '../core/types';

export type ChangeNode =
  | { readonly type: 'group'; readonly group: ChangeGroup }
  | { readonly type: 'file'; readonly file: ChangedFile };

const KIND_ICON: Readonly<Record<ChangeKind, vscode.ThemeIcon>> = {
  added: new vscode.ThemeIcon(
    'diff-added',
    new vscode.ThemeColor('gitDecoration.addedResourceForeground'),
  ),
  modified: new vscode.ThemeIcon(
    'diff-modified',
    new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'),
  ),
  deleted: new vscode.ThemeIcon(
    'diff-removed',
    new vscode.ThemeColor('gitDecoration.deletedResourceForeground'),
  ),
  renamed: new vscode.ThemeIcon(
    'diff-renamed',
    new vscode.ThemeColor('gitDecoration.renamedResourceForeground'),
  ),
};

const STATUS_ICON: Readonly<Record<ReviewStatus, string>> = {
  pending: '$(circle-filled)',
  accepted: '$(check)',
  rejected: '$(discard)',
};

/**
 * Renders the Changed Files panel. It holds no review logic: it displays whatever
 * snapshot of changes it is given and re-renders when that snapshot is replaced.
 */
export class ChangesTreeProvider implements vscode.TreeDataProvider<ChangeNode>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<ChangeNode | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  private files: readonly ChangedFile[] = [];

  constructor(private readonly workspaceRoot: vscode.Uri | undefined) {}

  setChanges(files: readonly ChangedFile[]): void {
    this.files = files;
    this.changeEmitter.fire(undefined);
  }

  getChanges(): readonly ChangedFile[] {
    return this.files;
  }

  /** Text for the view's description, e.g. "3 files · 2 pending". Empty when there is nothing. */
  describe(): string {
    if (this.files.length === 0) {
      return '';
    }
    const { pending } = countByStatus(this.files);
    const total = `${this.files.length} ${this.files.length === 1 ? 'file' : 'files'}`;
    return pending > 0 ? `${total} · ${pending} pending` : total;
  }

  getChildren(element?: ChangeNode): ChangeNode[] {
    if (!element) {
      return groupChanges(this.files).map((group) => ({ type: 'group', group }));
    }
    if (element.type === 'group') {
      return element.group.files.map((file) => ({ type: 'file', file }));
    }
    return [];
  }

  getTreeItem(element: ChangeNode): vscode.TreeItem {
    return element.type === 'group' ? this.groupItem(element.group) : this.fileItem(element.file);
  }

  private groupItem(group: ChangeGroup): vscode.TreeItem {
    const item = new vscode.TreeItem(
      CHANGE_KIND_LABEL[group.kind],
      vscode.TreeItemCollapsibleState.Expanded,
    );
    item.id = `group:${group.kind}`;
    item.description = String(group.files.length);
    item.iconPath = KIND_ICON[group.kind];
    item.contextValue = `group.${group.kind}`;
    return item;
  }

  private fileItem(file: ChangedFile): vscode.TreeItem {
    const { name, dir } = splitPath(file.path);
    const item = new vscode.TreeItem(name, vscode.TreeItemCollapsibleState.None);
    item.id = `file:${file.path}`;
    if (this.workspaceRoot) {
      // Lets the file icon theme pick the icon; a decoration provider will add the status badge.
      item.resourceUri = vscode.Uri.joinPath(this.workspaceRoot, file.path);
    }
    const location = file.kind === 'renamed' && file.oldPath ? `← ${file.oldPath}` : dir;
    item.description = [location, REVIEW_STATUS_LABEL[file.status]].filter(Boolean).join(' · ');
    item.contextValue = `file.${file.kind}.${file.status}`;

    const tooltip = new vscode.MarkdownString(undefined, true);
    tooltip.appendMarkdown(
      `${STATUS_ICON[file.status]} **${REVIEW_STATUS_LABEL[file.status]}** · `,
    );
    tooltip.appendMarkdown(`${CHANGE_KIND_LABEL[file.kind]}\n\n`);
    tooltip.appendText(file.path);
    if (file.oldPath) {
      tooltip.appendText(`\nRenamed from ${file.oldPath}`);
    }
    if (file.restoreBlocker) {
      tooltip.appendMarkdown('\n\n$(warning) ');
      tooltip.appendText(`Cannot be rejected automatically. ${file.restoreBlocker}`);
    }
    item.tooltip = tooltip;
    return item;
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}
