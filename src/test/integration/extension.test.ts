import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { ClaudeReviewInternals } from '../../extension/extension';

const EXTENSION_ID = 'local.claude-review';

suite('Claude Review extension', () => {
  let internals: ClaudeReviewInternals;

  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension<ClaudeReviewInternals>(EXTENSION_ID);
    assert.ok(ext, `${EXTENSION_ID} is not installed in the test host`);
    internals = await ext.activate();
  });

  test('activates and registers its commands', async () => {
    const commands = await vscode.commands.getCommands(true);
    for (const id of ['claudeReview.refresh', 'claudeReview.showLog']) {
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
});
