import * as vscode from 'vscode';
import { groupChanges } from '../core/grouping';
import {
  CHANGE_KIND_LABEL,
  REVIEW_STATUS_LABEL,
  type ChangedFile,
  type ReviewStatus,
} from '../core/types';
import { readConfig, SECTION } from '../extension/config';
import type { ReviewController } from '../extension/reviewController';
import type { ChangesTreeProvider } from '../providers/changesTreeProvider';
import { openReviewDiff } from '../providers/diffOpener';
import { parseReviewUri, REVIEW_SCHEME } from '../providers/reviewContentProvider';
import type { RestoreResult } from '../services/restore';

const CONTEXT_IN_DIFF = 'claudeReview.inReviewDiff';
const CONTEXT_DIFF_STATUS = 'claudeReview.activeReviewStatus';
const CONTEXT_FILTERED = 'claudeReview.filtered';

/** Registers per-file review commands and keeps the diff-editor context keys current. */
export function registerReviewCommands(
  controller: ReviewController | undefined,
  tree: ChangesTreeProvider,
): vscode.Disposable[] {
  const find = (key: string | undefined): ChangedFile | undefined =>
    key === undefined ? undefined : tree.getChanges().find((f) => f.key === key);

  /** Resolves a command argument from the tree, an editor title button, or the palette. */
  const resolve = (arg: unknown): ChangedFile | undefined => {
    if (isFileNode(arg)) {
      return find(arg.file.key);
    }
    if (isChangedFile(arg)) {
      return find(arg.key);
    }
    if (arg instanceof vscode.Uri) {
      return find(keyForUri(arg));
    }
    return find(activeDiffKey()) ?? find(keyForUri(vscode.window.activeTextEditor?.document.uri));
  };

  const keyForUri = (uri: vscode.Uri | undefined): string | undefined => {
    if (!uri) {
      return undefined;
    }
    if (uri.scheme === REVIEW_SCHEME) {
      return parseReviewUri(uri)?.key;
    }
    return uri.scheme === 'file' ? controller?.keyForFile(uri.fsPath) : undefined;
  };

  const requireController = (): ReviewController | undefined => {
    if (!controller?.activeSession) {
      void vscode.window.showInformationMessage(
        'No review session is active. Open a folder and run "Claude Review: Start New Review Session".',
      );
      return undefined;
    }
    return controller;
  };

  const pickPending = async (placeHolder: string): Promise<ChangedFile | undefined> => {
    const pending = orderedPending(tree);
    if (pending.length === 0) {
      void vscode.window.showInformationMessage('There are no pending changes to review.');
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      pending.map((f) => ({
        label: f.path,
        description: CHANGE_KIND_LABEL[f.kind],
        file: f,
      })),
      { placeHolder },
    );
    return picked?.file;
  };

  const afterDecision = async (file: ChangedFile, fromDiff: boolean): Promise<void> => {
    if (!fromDiff) {
      return;
    }
    await closeReviewDiffs(file.key);
    const c = requireController();
    if (c && readConfig().openNextAfterDecision) {
      const next = orderedPending(tree).find((f) => f.key !== file.key);
      if (next) {
        await openReviewDiff(c, next);
      }
    }
  };

  const accept = async (arg: unknown): Promise<void> => {
    const c = requireController();
    const file = resolve(arg);
    if (!c || !file) {
      return;
    }
    if (file.status !== 'pending') {
      void vscode.window.showInformationMessage(
        `${file.path} is already ${REVIEW_STATUS_LABEL[file.status].toLowerCase()}.`,
      );
      return;
    }
    const fromDiff = activeDiffKey() === file.key;
    const result = await c.accept(file.key);
    if (!result) {
      void vscode.window.showInformationMessage(`${file.path} no longer has a pending change.`);
      return;
    }
    if (!result.ok) {
      const choice = await vscode.window.showWarningMessage(
        `Could not accept ${file.path}`,
        { modal: true, detail: result.message },
        ...(result.reason === 'conflict' ? ['Review Latest'] : []),
      );
      if (choice === 'Review Latest') {
        const latest = find(file.key);
        if (latest) {
          await openReviewDiff(c, latest);
        }
      }
      return;
    }
    await afterDecision(file, fromDiff);
  };

  const reject = async (arg: unknown): Promise<void> => {
    const c = requireController();
    const file = resolve(arg);
    if (!c || !file) {
      return;
    }
    if (file.status !== 'pending') {
      void vscode.window.showInformationMessage(
        `${file.path} is already ${REVIEW_STATUS_LABEL[file.status].toLowerCase()}.`,
      );
      return;
    }
    if (file.restoreBlocker) {
      void vscode.window.showWarningMessage(`${file.path} cannot be rejected automatically.`, {
        modal: true,
        detail: `${file.restoreBlocker}\n\nRestore it manually if needed, then accept the change to clear it from the list.`,
      });
      return;
    }
    if (!(await confirmReject(file))) {
      return;
    }
    const fromDiff = activeDiffKey() === file.key;
    const outcome = await c.reject(file.key);
    if (!outcome) {
      void vscode.window.showInformationMessage(`${file.path} no longer has a pending change.`);
      return;
    }
    if (outcome.record) {
      await afterDecision(file, fromDiff);
      return;
    }
    await reportRejectFailure(c, file, outcome.results, find);
  };

  const updateContextKeys = (): void => {
    const key = activeDiffKey();
    const status = find(key)?.status;
    void vscode.commands.executeCommand('setContext', CONTEXT_IN_DIFF, key !== undefined);
    void vscode.commands.executeCommand('setContext', CONTEXT_DIFF_STATUS, status ?? '');
  };

  return [
    vscode.commands.registerCommand('claudeReview.openDiff', async (arg?: unknown) => {
      const c = requireController();
      const file = arg === undefined ? await pickPending('Select a file to review') : resolve(arg);
      if (c && file) {
        await openReviewDiff(c, file);
      }
    }),
    vscode.commands.registerCommand('claudeReview.reviewNext', async () => {
      const c = requireController();
      if (!c) {
        return;
      }
      const pending = orderedPending(tree);
      const current = activeDiffKey();
      const index = pending.findIndex((f) => f.key === current);
      const next = pending[(index + 1) % Math.max(pending.length, 1)];
      if (next) {
        await openReviewDiff(c, next);
      } else {
        void vscode.window.showInformationMessage('All changes have been reviewed.');
      }
    }),
    vscode.commands.registerCommand('claudeReview.acceptFile', accept),
    vscode.commands.registerCommand('claudeReview.rejectFile', reject),
    vscode.commands.registerCommand('claudeReview.openFile', async (arg?: unknown) => {
      const file = resolve(arg);
      const abs = file && controller?.absolutePath(file.key);
      if (!abs) {
        return;
      }
      try {
        await vscode.window.showTextDocument(vscode.Uri.file(abs), { preview: false });
      } catch {
        void vscode.window.showInformationMessage(`${file.path} does not exist on disk.`);
      }
    }),
    vscode.commands.registerCommand('claudeReview.filter', async () => {
      const current = tree.getFilter();
      const all: ReviewStatus[] = ['pending', 'accepted', 'rejected'];
      const picked = await vscode.window.showQuickPick(
        all.map((s) => ({ label: REVIEW_STATUS_LABEL[s], status: s, picked: current.has(s) })),
        { canPickMany: true, placeHolder: 'Show files with these review statuses' },
      );
      if (!picked) {
        return;
      }
      const next = picked.length === 0 ? all : picked.map((p) => p.status);
      tree.setFilter(new Set(next));
      void vscode.commands.executeCommand('setContext', CONTEXT_FILTERED, next.length < all.length);
    }),
    vscode.window.tabGroups.onDidChangeTabs(updateContextKeys),
    vscode.window.tabGroups.onDidChangeTabGroups(updateContextKeys),
    tree.onDidChangeTreeData(updateContextKeys),
  ];
}

async function confirmReject(file: ChangedFile): Promise<boolean> {
  if (!readConfig().confirmReject) {
    return true;
  }
  const name = `"${file.path}"`;
  const message = {
    added: `Delete ${name}? It did not exist when the review session started.`,
    modified: `Discard the changes to ${name} and restore its original content?`,
    deleted: `Restore the deleted file ${name}?`,
    renamed: `Move ${name} back to "${file.oldPath ?? ''}"?`,
  }[file.kind];
  const detail =
    (file.kind === 'added' ? 'The file will be moved to the trash. ' : '') +
    'A copy of the current content is kept in extension storage. No other files are changed.';
  const choice = await vscode.window.showWarningMessage(
    message,
    { modal: true, detail },
    'Reject',
    "Reject and Don't Ask Again",
  );
  if (choice === "Reject and Don't Ask Again") {
    await vscode.workspace
      .getConfiguration(SECTION)
      .update('confirmReject', false, vscode.ConfigurationTarget.Global);
  }
  return choice !== undefined;
}

async function reportRejectFailure(
  controller: ReviewController,
  file: ChangedFile,
  results: readonly RestoreResult[],
  find: (key: string) => ChangedFile | undefined,
): Promise<void> {
  const written = results.filter((r) => r.outcome === 'restored' || r.outcome === 'removed');
  const problems = results.filter(
    (r) => !['restored', 'removed', 'unchanged', 'skipped'].includes(r.outcome),
  );
  const lines = problems.map((r) => `${r.path}: ${r.message ?? r.outcome}`);
  const isConflict = problems.some((r) => r.outcome === 'conflict');

  if (written.length > 0) {
    // Partially applied (I/O failure halfway through a rename). Say exactly what happened.
    void vscode.window.showErrorMessage(`${file.path} was only partially restored.`, {
      modal: true,
      detail:
        `Restored: ${written.map((r) => r.path).join(', ')}\n` +
        `Not restored: ${lines.join('\n')}\n\n` +
        'Backups of the replaced content are in extension storage. See the Claude Review log for details.',
    });
    return;
  }
  const choice = await vscode.window.showWarningMessage(
    isConflict
      ? `${file.path} changed after you reviewed it.`
      : `${file.path} could not be restored.`,
    {
      modal: true,
      detail:
        `${lines.join('\n')}\n\nNothing was written.` +
        (isConflict
          ? ' Review the latest version, then reject it again if you still want to.'
          : ''),
    },
    ...(isConflict ? ['Review Latest'] : []),
  );
  if (choice === 'Review Latest') {
    const latest = find(file.key);
    if (latest) {
      await openReviewDiff(controller, latest);
    }
  }
}

/** Pending files in the same order the panel shows them. */
function orderedPending(tree: ChangesTreeProvider): ChangedFile[] {
  return groupChanges(tree.getChanges(), new Set(['pending'])).flatMap((g) => g.files);
}

/** Key of the review diff in the active editor tab, if it is one of ours. */
function activeDiffKey(): string | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (input instanceof vscode.TabInputTextDiff) {
    return parseReviewUri(input.original)?.key ?? parseReviewUri(input.modified)?.key;
  }
  return undefined;
}

async function closeReviewDiffs(key: string): Promise<void> {
  const tabs = vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .filter((tab) => {
      const input = tab.input;
      return (
        input instanceof vscode.TabInputTextDiff &&
        (parseReviewUri(input.original)?.key ?? parseReviewUri(input.modified)?.key) === key
      );
    });
  if (tabs.length > 0) {
    await vscode.window.tabGroups.close(tabs, true);
  }
}

function isFileNode(arg: unknown): arg is { type: 'file'; file: ChangedFile } {
  return (
    typeof arg === 'object' &&
    arg !== null &&
    (arg as { type?: unknown }).type === 'file' &&
    isChangedFile((arg as { file?: unknown }).file)
  );
}

function isChangedFile(arg: unknown): arg is ChangedFile {
  return (
    typeof arg === 'object' &&
    arg !== null &&
    typeof (arg as { key?: unknown }).key === 'string' &&
    typeof (arg as { status?: unknown }).status === 'string'
  );
}
