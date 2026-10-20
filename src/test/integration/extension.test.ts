import * as assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ChangedFile } from '../../core/types';
import type { ClaudeReviewInternals } from '../../extension/extension';
import { ReviewController } from '../../extension/reviewController';
import { SessionStore } from '../../storage/sessionStore';
import { SnapshotStore } from '../../storage/snapshotStore';

const EXTENSION_ID = 'local.claude-review';

suite('Claude Review extension', () => {
  let internals: ClaudeReviewInternals;

  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension<ClaudeReviewInternals>(EXTENSION_ID);
    assert.ok(ext, `${EXTENSION_ID} is not installed in the test host`);
    internals = await ext.activate();
    await internals.ready;
  });

  test('activates and registers its commands', async () => {
    const commands = await vscode.commands.getCommands(true);
    for (const id of [
      'claudeReview.refresh',
      'claudeReview.showLog',
      'claudeReview.startSession',
    ]) {
      assert.ok(commands.includes(id), `missing command ${id}`);
    }
  });

  test('changes view can be focused', async () => {
    await vscode.commands.executeCommand('claudeReview.changes.focus');
  });

  test('tree starts empty and renders grouped changes', () => {
    const tree = internals.changes;
    assert.deepEqual(tree.getChildren(), []);
    assert.equal(tree.describe(), '');

    tree.setChanges([
      { key: 'src/a.ts', path: 'src/a.ts', kind: 'modified', status: 'pending' },
      { key: 'new.ts', path: 'new.ts', kind: 'added', status: 'accepted' },
    ]);
    const groups = tree.getChildren();
    assert.deepEqual(
      groups.map((g) => tree.getTreeItem(g).label),
      ['Added', 'Modified'],
    );
    const [modifiedGroup] = groups.slice(1);
    assert.ok(modifiedGroup);
    const [fileNode] = tree.getChildren(modifiedGroup);
    assert.ok(fileNode);
    const item = tree.getTreeItem(fileNode);
    assert.equal(item.label, 'a.ts');
    assert.equal(item.description, 'src · Pending');
    assert.equal(item.contextValue, 'file.modified.pending');
    assert.equal(tree.describe(), '2 files · 1 pending');

    tree.setChanges([]);
  });

  test('refresh command runs without error', async () => {
    await vscode.commands.executeCommand('claudeReview.refresh');
  });

  test('starts a session and lists a file created on disk', async () => {
    const controller = internals.controller;
    assert.ok(controller, 'controller exists for the test workspace');
    const session = controller.activeSession;
    assert.ok(session, 'a session was started automatically');
    assert.equal(session.mode, 'filesystem'); // the test workspace is not a Git repository

    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert.ok(folder);
    await fs.writeFile(path.join(folder, 'created-by-test.txt'), 'hello\n');

    const seen = await waitFor(() =>
      internals.changes.getChanges().some((f) => f.path === 'created-by-test.txt'),
    );
    assert.ok(seen, 'watcher-driven refresh shows the new file');
    const file = internals.changes.getChanges().find((f) => f.path === 'created-by-test.txt');
    assert.equal(file?.kind, 'added');

    await fs.rm(path.join(folder, 'created-by-test.txt'));
    assert.ok(await waitFor(() => internals.changes.getChanges().length === 0));
  });

  suite('review flow', () => {
    let folder: string;
    const fileFor = (rel: string): ChangedFile | undefined =>
      internals.changes.getChanges().find((f) => f.path === rel);

    suiteSetup(async () => {
      const config = vscode.workspace.getConfiguration('claudeReview');
      await config.update('confirmReject', false, vscode.ConfigurationTarget.Global);
      await config.update('openNextAfterDecision', false, vscode.ConfigurationTarget.Global);
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      assert.ok(root);
      folder = root;
    });

    teardown(async () => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    test('opens a native diff, accepts, then rejects a later edit', async () => {
      await fs.writeFile(path.join(folder, 'flow.txt'), 'first version\n');
      assert.ok(await waitFor(() => fileFor('flow.txt')?.status === 'pending'));

      await vscode.commands.executeCommand('claudeReview.openDiff', fileFor('flow.txt'));
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      assert.ok(input instanceof vscode.TabInputTextDiff, 'a diff editor is active');
      assert.equal(input.original.scheme, 'claude-review');
      assert.equal(input.modified.fsPath, path.join(folder, 'flow.txt'));

      await vscode.commands.executeCommand('claudeReview.acceptFile', fileFor('flow.txt'));
      assert.equal(fileFor('flow.txt')?.status, 'accepted');
      assert.equal(await fs.readFile(path.join(folder, 'flow.txt'), 'utf8'), 'first version\n');

      await fs.writeFile(path.join(folder, 'flow.txt'), 'second version\n');
      assert.ok(await waitFor(() => fileFor('flow.txt')?.status === 'pending'));
      assert.equal(fileFor('flow.txt')?.kind, 'modified');

      await vscode.commands.executeCommand('claudeReview.openDiff', fileFor('flow.txt'));
      const diff = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      assert.ok(diff instanceof vscode.TabInputTextDiff);
      const original = await vscode.workspace.openTextDocument(diff.original);
      assert.equal(original.getText(), 'first version\n', 'left side is the accepted baseline');

      await vscode.commands.executeCommand('claudeReview.rejectFile', fileFor('flow.txt'));
      assert.equal(await fs.readFile(path.join(folder, 'flow.txt'), 'utf8'), 'first version\n');
      assert.equal(fileFor('flow.txt')?.status, 'rejected');
    });

    test('rejecting an added file removes it', async () => {
      await fs.writeFile(path.join(folder, 'added.txt'), 'remove me\n');
      assert.ok(await waitFor(() => fileFor('added.txt')?.status === 'pending'));
      await vscode.commands.executeCommand('claudeReview.rejectFile', fileFor('added.txt'));
      await assert.rejects(fs.stat(path.join(folder, 'added.txt')));
      assert.equal(fileFor('added.txt')?.status, 'rejected');
    });

    test('binary files open as a description instead of garbled text', async () => {
      await fs.writeFile(path.join(folder, 'image.bin'), Buffer.from([0x89, 0x50, 0x00, 0x01]));
      assert.ok(await waitFor(() => fileFor('image.bin')?.status === 'pending'));
      await vscode.commands.executeCommand('claudeReview.openDiff', fileFor('image.bin'));
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      assert.ok(input instanceof vscode.TabInputTextDiff);
      const right = await vscode.workspace.openTextDocument(input.modified);
      assert.match(right.getText(), /binary file/);
    });

    test('a deleted file shows its original content and can be restored', async () => {
      await fs.writeFile(path.join(folder, 'keep.txt'), 'precious\n');
      assert.ok(await waitFor(() => fileFor('keep.txt')?.status === 'pending'));
      await vscode.commands.executeCommand('claudeReview.acceptFile', fileFor('keep.txt'));

      await fs.rm(path.join(folder, 'keep.txt'));
      assert.ok(await waitFor(() => fileFor('keep.txt')?.kind === 'deleted'));
      await vscode.commands.executeCommand('claudeReview.openDiff', fileFor('keep.txt'));
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      assert.ok(input instanceof vscode.TabInputTextDiff);
      const left = await vscode.workspace.openTextDocument(input.original);
      assert.equal(left.getText(), 'precious\n');

      await vscode.commands.executeCommand('claudeReview.rejectFile', fileFor('keep.txt'));
      assert.equal(await fs.readFile(path.join(folder, 'keep.txt'), 'utf8'), 'precious\n');
    });
  });

  suite('Claude Code hook events', () => {
    test('events from the real hook script attribute a change to Claude', async () => {
      const storage = internals.storageDir;
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      assert.ok(storage && root);
      const config = JSON.parse(
        await fs.readFile(path.join(storage, 'hook-config.json'), 'utf8'),
      ) as {
        root: string;
      };
      assert.equal(config.root, root);

      const ext = vscode.extensions.getExtension('local.claude-review');
      assert.ok(ext);
      const hookScript = path.join(ext.extensionPath, 'dist', 'hook.js');
      const file = path.join(root, 'claude-edit.txt');
      const runHook = (event: string): Promise<number | null> =>
        new Promise((resolve, reject) => {
          const child = spawn(process.env.npm_node_execpath ?? 'node', [
            hookScript,
            '--storage',
            storage,
          ]);
          child.on('error', reject);
          child.on('close', resolve);
          child.stdin.end(
            JSON.stringify({
              session_id: 'it-session',
              cwd: root,
              hook_event_name: event,
              tool_name: 'Write',
              tool_input: { file_path: file, content: 'from claude\n' },
            }),
          );
        });

      assert.equal(await runHook('PreToolUse'), 0);
      await fs.writeFile(file, 'from claude\n');
      assert.equal(await runHook('PostToolUse'), 0);

      const fileFor = (): ChangedFile | undefined =>
        internals.changes.getChanges().find((f) => f.path === 'claude-edit.txt');
      assert.ok(
        await waitFor(() => fileFor()?.origin === 'claude'),
        'change is attributed to Claude',
      );
      assert.equal(fileFor()?.kind, 'added');
    });
  });

  suite('batch actions, undo, and recovery', () => {
    let folder: string;
    const fileFor = (rel: string): ChangedFile | undefined =>
      internals.changes.getChanges().find((f) => f.path === rel);
    const write = (rel: string, text: string): Promise<void> =>
      fs.writeFile(path.join(folder, rel), text);
    const readFile = (rel: string): Promise<string> => fs.readFile(path.join(folder, rel), 'utf8');

    suiteSetup(() => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      assert.ok(root);
      folder = root;
    });

    test('reject all, then undo, round-trips every file', async () => {
      const controller = internals.controller;
      assert.ok(controller);
      await write('batch-1.txt', 'one\n');
      await write('batch-2.txt', 'two\n');
      assert.ok(
        await waitFor(
          () => fileFor('batch-1.txt') !== undefined && fileFor('batch-2.txt') !== undefined,
        ),
      );
      await controller.accept(['batch-1.txt', 'batch-2.txt']);
      await write('batch-1.txt', 'one changed\n');
      await write('batch-2.txt', 'two changed\n');
      assert.ok(
        await waitFor(
          () =>
            fileFor('batch-1.txt')?.status === 'pending' &&
            fileFor('batch-2.txt')?.status === 'pending',
        ),
      );

      const report = await controller.reject(['batch-1.txt', 'batch-2.txt']);
      assert.deepEqual([...report.succeeded].sort(), ['batch-1.txt', 'batch-2.txt']);
      assert.equal(await readFile('batch-1.txt'), 'one\n');
      assert.equal(await readFile('batch-2.txt'), 'two\n');
      assert.equal(controller.describeUndo(), 'Reject of 2 files');

      const undone = await controller.undo();
      assert.equal(undone?.succeeded.length, 2);
      assert.equal(await readFile('batch-1.txt'), 'one changed\n');
      assert.equal(await readFile('batch-2.txt'), 'two changed\n');
      assert.equal(fileFor('batch-1.txt')?.status, 'pending');
    });

    test('a new controller on the same storage resumes the session (reload)', async () => {
      const controller = internals.controller;
      const storageDir = internals.storageDir;
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      assert.ok(controller?.activeSession && storageDir && workspaceFolder);
      const before = controller.activeSession;
      const pendingBefore = controller.detectedChanges.map((c) => c.path).sort();

      const log = vscode.window.createOutputChannel('Claude Review test', { log: true });
      const resumed = new ReviewController({
        folder: workspaceFolder,
        sessions: new SessionStore(storageDir),
        snapshots: new SnapshotStore(path.join(storageDir, 'snapshots')),
        log,
        viewId: 'claudeReview.changes',
        gitPath: undefined,
      });
      try {
        await resumed.initialize();
        assert.equal(resumed.activeSession?.id, before.id);
        assert.deepEqual(resumed.detectedChanges.map((c) => c.path).sort(), pendingBefore);
        assert.equal(resumed.describeUndo(), controller.describeUndo());
      } finally {
        resumed.dispose();
        log.dispose();
      }
    });

    test('ending the session clears the list without touching files', async () => {
      const controller = internals.controller;
      assert.ok(controller);
      const pending = internals.changes.getChanges().length;
      assert.ok(pending > 0);
      await controller.endSession();
      assert.equal(controller.activeSession, undefined);
      assert.equal(internals.changes.getChanges().length, 0);
      assert.equal(await readFile('batch-1.txt'), 'one changed\n');

      await controller.startSession();
      assert.ok(controller.activeSession);
      assert.equal(internals.changes.getChanges().length, 0, 'new baseline includes current files');
    });
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return predicate();
}
