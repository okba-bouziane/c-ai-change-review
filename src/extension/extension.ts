import * as vscode from 'vscode';
import { ChangesTreeProvider } from '../providers/changesTreeProvider';

export const VIEW_ID = 'claudeReview.changes';

/**
 * Internal handle returned from activate(). Used only by this extension's integration
 * tests; it is not a public API and may change without notice.
 */
export interface ClaudeReviewInternals {
  readonly changes: ChangesTreeProvider;
}

export function activate(context: vscode.ExtensionContext): ClaudeReviewInternals {
  const log = vscode.window.createOutputChannel('Claude Review', { log: true });
  context.subscriptions.push(log);

  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  const changes = new ChangesTreeProvider(root);
  const view = vscode.window.createTreeView(VIEW_ID, {
    treeDataProvider: changes,
    showCollapseAll: true,
  });
  context.subscriptions.push(changes, view);

  const updateViewChrome = (): void => {
    view.description = changes.describe();
    const pending = changes.getChanges().filter((f) => f.status === 'pending').length;
    view.badge =
      pending > 0
        ? {
            value: pending,
            tooltip: `${pending} ${pending === 1 ? 'file' : 'files'} pending review`,
          }
        : undefined;
  };
  context.subscriptions.push(changes.onDidChangeTreeData(updateViewChrome));

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeReview.refresh', () => {
      // Change detection arrives in Phase 2; until then refresh just re-renders.
      changes.setChanges(changes.getChanges());
    }),
    vscode.commands.registerCommand('claudeReview.showLog', () => {
      log.show(true);
    }),
  );

  log.info(`Activated (workspace: ${root?.fsPath ?? 'none'})`);
  return { changes };
}

export function deactivate(): void {
  // Everything is registered on context.subscriptions and disposed by VS Code.
}
