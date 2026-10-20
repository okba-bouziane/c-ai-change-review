import * as vscode from 'vscode';
import { groupChanges } from '../core/grouping';
import {
  CHANGE_KIND_LABEL,
  REVIEW_STATUS_LABEL,
  type ChangeKind,
  type ChangedFile,
  type ReviewStatus,
} from '../core/types';
import { readConfig, SECTION } from '../extension/config';
import type { ReviewController } from '../extension/reviewController';
import type { ChangesTreeProvider } from '../providers/changesTreeProvider';
import { openReviewDiff } from '../providers/diffOpener';
import { parseReviewUri, REVIEW_SCHEME } from '../providers/reviewContentProvider';
import { isCompleteSuccess, type ActionReport } from '../services/actions';

const CONTEXT_IN_DIFF = 'claudeReview.inReviewDiff';
const CONTEXT_DIFF_STATUS = 'claudeReview.activeReviewStatus';
const CONTEXT_FILTERED = 'claudeReview.filtered';
const CONTEXT_HAS_SESSION = 'claudeReview.hasSession';
const CONTEXT_HAS_PENDING = 'claudeReview.hasPending';
const CONTEXT_CAN_UNDO = 'claudeReview.canUndo';

/** Registers review commands, the status bar item, and the context keys menus depend on. */
export function registerReviewCommands(
  controller: ReviewController | undefined,
  tree: ChangesTreeProvider,
  log: vscode.LogOutputChannel,
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
        'No review session is active. Run "Claude Review: Start New Review Session" first.',
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
      pending.map((f) => ({ label: f.path, description: CHANGE_KIND_LABEL[f.kind], file: f })),
      { placeHolder },
    );
    return picked?.file;
  };

  const showDetails = (): void => {
    log.show(true);
  };

  const afterDecision = async (file: ChangedFile, fromDiff: boolean): Promise<void> => {
    if (!fromDiff) {
      return;
    }
    await closeReviewDiffs([file.key]);
    const c = requireController();
    if (c && readConfig().openNextAfterDecision) {
      const next = orderedPending(tree).find((f) => f.key !== file.key);
      if (next) {
        await openReviewDiff(c, next);
      }
    }
  };

  /** Explains a single-file action that did not fully succeed. */
  const reportSingle = async (
    c: ReviewController,
    file: ChangedFile,
    report: ActionReport,
  ): Promise<void> => {
    const verb = report.action === 'accept' ? 'accept' : 'reject';
    const [conflict] = report.conflicts;
    const [blocked] = report.blocked;
    const [failed] = report.failed;
    if (failed) {
      void vscode.window.showErrorMessage(`Could not ${verb} ${file.path}.`, {
        modal: true,
        detail: `${failed.message}\n\nSee the Claude Review log for details.`,
      });
      return;
    }
    const issue = conflict ?? blocked;
    const choice = await vscode.window.showWarningMessage(
      conflict ? `${file.path} changed after you reviewed it.` : `Could not ${verb} ${file.path}.`,
      {
        modal: true,
        detail:
          `${issue?.message ?? ''}\n\nNothing was changed.` +
          (conflict
            ? ` Review the latest version, then ${verb} it again if you still want to.`
            : ''),
      },
      ...(conflict ? ['Review Latest'] : []),
    );
    const latest = find(file.key);
    if (choice === 'Review Latest' && latest) {
      await openReviewDiff(c, latest);
    }
  };

  const decideOne = async (arg: unknown, action: 'accept' | 'reject'): Promise<void> => {
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
    if (action === 'reject') {
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
    }
    const fromDiff = activeDiffKey() === file.key;
    const report = action === 'accept' ? await c.accept([file.key]) : await c.reject([file.key]);
    if (isCompleteSuccess(report)) {
      vscode.window.setStatusBarMessage(
        `$(check) ${action === 'accept' ? 'Accepted' : 'Rejected'} ${file.path}`,
        3000,
      );
      await afterDecision(file, fromDiff);
    } else {
      await reportSingle(c, file, report);
    }
  };

  const acceptAll = async (): Promise<void> => {
    const c = requireController();
    if (!c) {
      return;
    }
    const pending = orderedPending(tree);
    if (pending.length === 0) {
      void vscode.window.showInformationMessage('There are no pending changes to accept.');
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      `Accept all ${pending.length} pending ${plural(pending.length, 'change')}?`,
      {
        modal: true,
        detail:
          `${summarizeKinds(pending, 'accept')}\n\n` +
          'Files stay exactly as they are. Nothing is staged or committed. ' +
          '"Undo Last Review Action" can reverse this.',
      },
      `Accept ${pending.length} ${plural(pending.length, 'File')}`,
    );
    if (!choice) {
      return;
    }
    const report = await runWithProgress('Accepting changes', pending.length, (options) =>
      c.accept(
        pending.map((f) => f.key),
        options,
      ),
    );
    await closeReviewDiffs(report.succeeded);
    await showBatchReport(report, pending.length, showDetails);
  };

  const rejectAll = async (): Promise<void> => {
    const c = requireController();
    if (!c) {
      return;
    }
    const pending = orderedPending(tree);
    const rejectable = pending.filter((f) => !f.restoreBlocker);
    const blocked = pending.length - rejectable.length;
    if (rejectable.length === 0) {
      void vscode.window.showInformationMessage(
        pending.length === 0
          ? 'There are no pending changes to reject.'
          : 'None of the pending changes can be rejected automatically.',
      );
      return;
    }

    // Preview: every file that would be touched, all selected; the user can deselect.
    const picked = await vscode.window.showQuickPick(
      rejectable.map((f) => ({
        label: f.path,
        description: `${CHANGE_KIND_LABEL[f.kind]} · ${rejectEffect(f)}`,
        picked: true,
        file: f,
      })),
      {
        canPickMany: true,
        title: `Reject All — ${rejectable.length} ${plural(rejectable.length, 'file')}`,
        placeHolder:
          blocked > 0
            ? `Deselect files to keep. ${blocked} ${plural(blocked, 'file')} cannot be rejected automatically and ${blocked === 1 ? 'is' : 'are'} not listed.`
            : 'Deselect files to keep, then press Enter.',
      },
    );
    if (!picked || picked.length === 0) {
      return;
    }
    const files = picked.map((p) => p.file);
    const choice = await vscode.window.showWarningMessage(
      `Reject ${files.length} ${plural(files.length, 'change')}?`,
      {
        modal: true,
        detail:
          `${summarizeKinds(files, 'reject')}\n\n` +
          'Only these files are touched. A copy of their current content is kept in extension storage, ' +
          'and "Undo Last Review Action" can put it back. Files that changed after this list was ' +
          'computed are skipped and reported.',
      },
      `Reject ${files.length} ${plural(files.length, 'File')}`,
    );
    if (!choice) {
      return;
    }
    const report = await runWithProgress('Rejecting changes', files.length, (options) =>
      c.reject(
        files.map((f) => f.key),
        options,
      ),
    );
    await closeReviewDiffs(report.succeeded);
    await showBatchReport(report, files.length, showDetails);
  };

  const undo = async (): Promise<void> => {
    const c = requireController();
    if (!c) {
      return;
    }
    const description = c.describeUndo();
    if (!description) {
      void vscode.window.showInformationMessage('There is no review action to undo.');
      return;
    }
    const isReject = description.startsWith('Reject');
    const choice = await vscode.window.showWarningMessage(
      `Undo ${description}?`,
      {
        modal: true,
        detail: isReject
          ? 'The rejected content is written back to those files. Files that changed since the reject are skipped and reported.'
          : 'The files are not modified. They return to the list as pending changes.',
      },
      'Undo',
    );
    if (choice !== 'Undo') {
      return;
    }
    const report = await c.undo();
    if (report) {
      await showBatchReport(report, report.succeeded.length + countIssues(report), showDetails);
    }
  };

  const endSession = async (): Promise<void> => {
    const c = requireController();
    if (!c) {
      return;
    }
    const pending = orderedPending(tree).length;
    const choice = await vscode.window.showWarningMessage(
      'End the review session?',
      {
        modal: true,
        detail:
          (pending > 0
            ? `${pending} pending ${plural(pending, 'change')} will no longer be listed. `
            : '') +
          'No files are modified: pending changes stay in your workspace as they are. ' +
          'Changes are not tracked again until you start a new session.',
      },
      'End Session',
    );
    if (choice === 'End Session') {
      await closeReviewDiffs(tree.getChanges().map((f) => f.key));
      await c.endSession();
    }
  };

  const statusBar = vscode.window.createStatusBarItem(
    'claudeReview.status',
    vscode.StatusBarAlignment.Left,
    50,
  );
  statusBar.name = 'Claude Review';
  statusBar.command = 'claudeReview.changes.focus';

  const updateContextKeys = (): void => {
    const key = activeDiffKey();
    const pending = tree.getChanges().filter((f) => f.status === 'pending').length;
    void vscode.commands.executeCommand('setContext', CONTEXT_IN_DIFF, key !== undefined);
    void vscode.commands.executeCommand('setContext', CONTEXT_DIFF_STATUS, find(key)?.status ?? '');
    void vscode.commands.executeCommand(
      'setContext',
      CONTEXT_HAS_SESSION,
      controller?.activeSession !== undefined,
    );
    void vscode.commands.executeCommand('setContext', CONTEXT_HAS_PENDING, pending > 0);
    void vscode.commands.executeCommand(
      'setContext',
      CONTEXT_CAN_UNDO,
      controller?.canUndo ?? false,
    );
    if (pending > 0) {
      statusBar.text = `$(checklist) ${pending}`;
      statusBar.tooltip = `Claude Review: ${pending} ${plural(pending, 'change')} pending review`;
      statusBar.show();
    } else {
      statusBar.hide();
    }
  };
  updateContextKeys();

  return [
    statusBar,
    vscode.commands.registerCommand('claudeReview.openDiff', async (arg?: unknown) => {
      const c = requireController();
      const file = arg === undefined ? await pickPending('Select a file to review') : resolve(arg);
      if (c && file) {
        await openReviewDiff(c, file);
      }
    }),
    vscode.commands.registerCommand('claudeReview.reviewAll', async () => {
      const c = requireController();
      const [first] = orderedPending(tree);
      if (!c) {
        return;
      }
      if (first) {
        await openReviewDiff(c, first);
      } else {
        void vscode.window.showInformationMessage('There are no pending changes to review.');
      }
    }),
    vscode.commands.registerCommand('claudeReview.reviewNext', async () => {
      const c = requireController();
      if (!c) {
        return;
      }
      const pending = orderedPending(tree);
      const index = pending.findIndex((f) => f.key === activeDiffKey());
      const next = pending[(index + 1) % Math.max(pending.length, 1)];
      if (next) {
        await openReviewDiff(c, next);
      } else {
        void vscode.window.showInformationMessage('All changes have been reviewed.');
      }
    }),
    vscode.commands.registerCommand('claudeReview.acceptFile', (arg?: unknown) =>
      decideOne(arg, 'accept'),
    ),
    vscode.commands.registerCommand('claudeReview.rejectFile', (arg?: unknown) =>
      decideOne(arg, 'reject'),
    ),
    vscode.commands.registerCommand('claudeReview.acceptAll', acceptAll),
    vscode.commands.registerCommand('claudeReview.rejectAll', rejectAll),
    vscode.commands.registerCommand('claudeReview.undo', undo),
    vscode.commands.registerCommand('claudeReview.endSession', endSession),
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
    'A copy of the current content is kept in extension storage, and "Undo Last Review Action" can put it back. No other files are changed.';
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

async function runWithProgress(
  title: string,
  total: number,
  run: (options: {
    signal: AbortSignal;
    onProgress: (done: number, total: number, key: string) => void;
  }) => Promise<ActionReport>,
): Promise<ActionReport> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title, cancellable: true },
    async (progress, token) => {
      const abort = new AbortController();
      token.onCancellationRequested(() => {
        abort.abort();
      });
      let last = 0;
      return run({
        signal: abort.signal,
        onProgress: (done, count, key) => {
          progress.report({
            message: `${done + 1}/${count} ${key}`,
            increment: ((done - last) / total) * 100,
          });
          last = done;
        },
      });
    },
  );
}

/** Reports a batch outcome. Never says "done" unless every file succeeded. */
async function showBatchReport(
  report: ActionReport,
  requested: number,
  showDetails: () => void,
): Promise<void> {
  const verb = { accept: 'Accepted', reject: 'Rejected', undo: 'Undid' }[report.action];
  const ok = report.succeeded.length;
  if (isCompleteSuccess(report)) {
    const choice = await vscode.window.showInformationMessage(
      `${verb} ${ok} ${plural(ok, 'file')}.`,
      ...(report.action === 'undo' ? [] : ['Undo']),
    );
    if (choice === 'Undo') {
      await vscode.commands.executeCommand('claudeReview.undo');
    }
    return;
  }
  const parts = [
    report.conflicts.length > 0 ? `${report.conflicts.length} changed since review` : '',
    report.blocked.length > 0 ? `${report.blocked.length} could not be done safely` : '',
    report.failed.length > 0 ? `${report.failed.length} failed` : '',
    report.cancelled.length > 0 ? `${report.cancelled.length} cancelled` : '',
  ].filter(Boolean);
  const message = `${verb} ${ok} of ${requested} ${plural(requested, 'file')}. Not done: ${parts.join(', ')}.`;
  const show =
    report.failed.length > 0 ? vscode.window.showErrorMessage : vscode.window.showWarningMessage;
  const choice = await show(message, 'Show Details');
  if (choice === 'Show Details') {
    showDetails();
  }
}

function countIssues(r: ActionReport): number {
  return r.conflicts.length + r.blocked.length + r.failed.length + r.cancelled.length;
}

function rejectEffect(f: ChangedFile): string {
  switch (f.kind) {
    case 'added':
      return 'will be moved to the trash';
    case 'modified':
      return 'original content restored';
    case 'deleted':
      return 'will be recreated';
    case 'renamed':
      return `moved back to ${f.oldPath ?? 'its old path'}`;
  }
}

function summarizeKinds(files: readonly ChangedFile[], action: 'accept' | 'reject'): string {
  const counts = new Map<ChangeKind, number>();
  for (const f of files) {
    counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1);
  }
  const lines: string[] = [];
  const line = (kind: ChangeKind, acceptText: string, rejectText: string): void => {
    const n = counts.get(kind) ?? 0;
    if (n > 0) {
      lines.push(`• ${n} ${plural(n, 'file')} ${action === 'accept' ? acceptText : rejectText}`);
    }
  };
  line('added', 'added (kept)', 'added (moved to the trash)');
  line('modified', 'modified (kept)', 'modified (original content restored)');
  line('deleted', 'deleted (stay deleted)', 'deleted (recreated)');
  line('renamed', 'renamed (kept)', 'renamed (moved back)');
  return lines.join('\n');
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
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

async function closeReviewDiffs(keys: readonly string[]): Promise<void> {
  const wanted = new Set(keys);
  const tabs = vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .filter((tab) => {
      const input = tab.input;
      if (!(input instanceof vscode.TabInputTextDiff)) {
        return false;
      }
      const key = parseReviewUri(input.original)?.key ?? parseReviewUri(input.modified)?.key;
      return key !== undefined && wanted.has(key);
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
