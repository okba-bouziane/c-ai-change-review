import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ChangedFile } from '../../core/types';
import type { ClaudeReviewInternals } from '../../extension/extension';

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
