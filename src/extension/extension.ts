import * as path from 'node:path';
import * as vscode from 'vscode';
import { registerReviewCommands } from '../commands/reviewCommands';
import { ChangesTreeProvider } from '../providers/changesTreeProvider';
import { REVIEW_SCHEME, ReviewContentProvider } from '../providers/reviewContentProvider';
import { SessionStore } from '../storage/sessionStore';
import { SnapshotStore } from '../storage/snapshotStore';
import { readConfig } from './config';
import { HookIntegration } from './hookIntegration';
import { ReviewController } from './reviewController';

export const VIEW_ID = 'claudeReview.changes';

/**
 * Internal handle returned from activate(). Used only by this extension's integration
 * tests; it is not a public API and may change without notice.
 */
export interface ClaudeReviewInternals {
  readonly changes: ChangesTreeProvider;
  readonly controller: ReviewController | undefined;
  /** Resolves once the initial session has been loaded or captured. */
  readonly ready: Promise<void>;
  /** Extension storage directory for this workspace, if any. */
  readonly storageDir: string | undefined;
}

export function activate(context: vscode.ExtensionContext): ClaudeReviewInternals {
  const log = vscode.window.createOutputChannel('Claude Review', { log: true });
  context.subscriptions.push(log);

  const folder = vscode.workspace.workspaceFolders?.[0];
  const changes = new ChangesTreeProvider(folder?.uri);
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

  let controller: ReviewController | undefined;
  if (folder && context.storageUri) {
    if ((vscode.workspace.workspaceFolders?.length ?? 0) > 1) {
      log.warn(`Multi-root workspace: only the first folder (${folder.name}) is reviewed.`);
    }
    const storage = context.storageUri.fsPath;
    controller = new ReviewController({
      folder,
      sessions: new SessionStore(storage),
      snapshots: new SnapshotStore(path.join(storage, 'snapshots')),
      log,
      viewId: VIEW_ID,
      gitPath: findGitPath(),
    });
    context.subscriptions.push(
      controller,
      controller.onDidChange((files) => {
        changes.setChanges(files);
      }),
    );
  }

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      REVIEW_SCHEME,
      new ReviewContentProvider(() =>
        controller ? (b, key) => controller.readBaseline(b, key) : undefined,
      ),
    ),
    ...registerReviewCommands(controller, changes, log),
  );

  let hooks: HookIntegration | undefined;
  if (controller && folder && context.storageUri) {
    hooks = new HookIntegration(context, folder, context.storageUri.fsPath, controller, log);
    context.subscriptions.push(
      hooks,
      controller.onClaudeStopped(async (pending) => {
        if (pending === 0 || !readConfig(folder).notifyOnStop) {
          return;
        }
        const choice = await vscode.window.showInformationMessage(
          `Claude Code finished. ${pending} ${pending === 1 ? 'change is' : 'changes are'} ready to review.`,
          'Review All',
          'Open Panel',
        );
        if (choice === 'Review All') {
          await vscode.commands.executeCommand('claudeReview.reviewAll');
        } else if (choice === 'Open Panel') {
          await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
        }
      }),
    );
  }

  const ready = (controller?.initialize() ?? Promise.resolve())
    .then(() => hooks?.start())
    .catch((e: unknown) => {
      log.error(`Could not start review tracking: ${e instanceof Error ? e.message : String(e)}`);
      void vscode.window.showErrorMessage(
        `Claude Review could not start tracking changes: ${e instanceof Error ? e.message : String(e)}`,
      );
    });

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeReview.refresh', async () => {
      await controller?.refresh({ full: true });
    }),
    vscode.commands.registerCommand('claudeReview.startSession', async () => {
      if (!controller) {
        void vscode.window.showInformationMessage('Open a folder to start a review session.');
        return;
      }
      const pending = changes.getChanges().length;
      if (pending > 0) {
        const choice = await vscode.window.showWarningMessage(
          `Start a new review session?`,
          {
            modal: true,
            detail:
              `The workspace as it is now becomes the new baseline. The ${pending} ` +
              `${pending === 1 ? 'change' : 'changes'} listed now will no longer be shown for review. ` +
              'No files are modified.',
          },
          'Start New Session',
        );
        if (choice !== 'Start New Session') {
          return;
        }
      }
      await controller.startSession();
    }),
    vscode.commands.registerCommand('claudeReview.showLog', () => {
      log.show(true);
    }),
  );

  log.info(`Activated (workspace: ${folder?.uri.fsPath ?? 'none'})`);
  return { changes, controller, ready, storageDir: context.storageUri?.fsPath };
}

export function deactivate(): void {
  // Everything is registered on context.subscriptions and disposed by VS Code.
}

interface GitExtensionApi {
  getAPI(version: 1): { readonly git: { readonly path: string } };
}

/** Uses the Git binary that VS Code's built-in Git extension found, falling back to PATH. */
function findGitPath(): string | undefined {
  try {
    const ext = vscode.extensions.getExtension<{ enabled: boolean } & GitExtensionApi>(
      'vscode.git',
    );
    if (ext?.isActive && ext.exports.enabled) {
      return ext.exports.getAPI(1).git.path;
    }
  } catch {
    // Fall through to PATH lookup.
  }
  return undefined;
}
