import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
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
      { path: 'src/a.ts', kind: 'modified', status: 'pending' },
      { path: 'new.ts', kind: 'added', status: 'accepted' },
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
