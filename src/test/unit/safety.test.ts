import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { stateToken } from '../../core/session';
import { restoreGroup } from '../../services/restore';
import {
  cleanupTempDirs,
  git,
  Harness,
  initRepo,
  read,
  readText,
  tempDir,
  write,
} from './helpers/workspace';

afterEach(cleanupTempDirs);

/** Snapshot of everything Git knows, to prove a restore touched nothing else. */
async function gitState(root: string): Promise<{ head: string; index: string; status: string }> {
  return {
    head: (await git(root, 'rev-parse', 'HEAD')).trim(),
    index: await git(root, 'ls-files', '-s'),
    status: await git(root, 'status', '--porcelain=v1', '--untracked-files=all'),
  };
}

describe('1. modifying a tracked file and rejecting it', () => {
  it('restores the exact original bytes', async () => {
    const original = 'line one\r\nline two\r\n\ttrailing  \r\n';
    const root = await initRepo({ 'src/app.ts': original, 'other.ts': 'other\n' });
    const h = await Harness.start(root);
    const before = await gitState(root);

    await write(root, 'src/app.ts', 'rewritten by claude\n');
    const change = await h.change('src/app.ts');
    expect(change.kind).toBe('modified');

    const [result] = await h.reject(change);
    expect(result?.outcome).toBe('restored');
    expect(await readText(root, 'src/app.ts')).toBe(original);
    expect(await gitState(root)).toEqual(before);
    expect(await h.detect()).toEqual([]);
  });
});

describe('2. creating a new file and rejecting it', () => {
  it('removes only the new file', async () => {
    const root = await initRepo({ 'keep.ts': 'keep\n' });
    const h = await Harness.start(root);

    await write(root, 'feature/new.ts', 'export const x = 1;\n');
    const change = await h.change('feature/new.ts');
    expect(change.kind).toBe('added');

    const [result] = await h.reject(change);
    expect(result?.outcome).toBe('removed');
    expect(await read(root, 'feature/new.ts')).toBeUndefined();
    expect(await readText(root, 'keep.ts')).toBe('keep\n');
    expect(result?.replaced?.type).toBe('stored');
  });
});

describe('3. deleting an existing file and restoring it', () => {
  it('restores content and the executable bit', async () => {
    const root = await initRepo({ 'bin/run.sh': '#!/bin/sh\necho hi\n' });
    await fs.chmod(path.join(root, 'bin/run.sh'), 0o755);
    await git(root, 'add', '-A');
    await git(root, 'commit', '-q', '-m', 'exec');
    const h = await Harness.start(root);

    await fs.rm(path.join(root, 'bin/run.sh'));
    await fs.rmdir(path.join(root, 'bin'));
    const change = await h.change('bin/run.sh');
    expect(change.kind).toBe('deleted');

    const [result] = await h.reject(change);
    expect(result?.outcome).toBe('restored');
    expect(await readText(root, 'bin/run.sh')).toBe('#!/bin/sh\necho hi\n');
    expect((await fs.stat(path.join(root, 'bin/run.sh'))).mode & 0o777).toBe(0o755);
  });
});

describe('4. renaming a file', () => {
  it('is detected as a rename and rejecting restores the old path', async () => {
    const root = await initRepo({ 'old/name.ts': 'unique content 42\n', 'x.ts': 'x\n' });
    const h = await Harness.start(root);

    await fs.mkdir(path.join(root, 'new'));
    await fs.rename(path.join(root, 'old/name.ts'), path.join(root, 'new/name.ts'));
    const changes = await h.detect();
    expect(changes).toHaveLength(1);
    const [rename] = changes;
    if (!rename) {
      throw new Error('expected a rename');
    }
    expect(rename.kind).toBe('renamed');
    expect(rename.oldPath).toBe('old/name.ts');
    expect(rename.path).toBe('new/name.ts');

    const results = await h.reject(rename);
    expect(results.map((r) => r.outcome)).toEqual(['restored', 'removed']);
    expect(await readText(root, 'old/name.ts')).toBe('unique content 42\n');
    expect(await read(root, 'new/name.ts')).toBeUndefined();
  });

  it('does not pair ambiguous duplicates as a rename', async () => {
    const root = await initRepo({ 'a.txt': 'same\n', 'b.txt': 'same\n' });
    const h = await Harness.start(root);
    await fs.rename(path.join(root, 'a.txt'), path.join(root, 'c.txt'));
    await fs.rename(path.join(root, 'b.txt'), path.join(root, 'd.txt'));
    const kinds = (await h.detect()).map((c) => `${c.kind}:${c.path}`);
    expect(kinds).toEqual(['deleted:a.txt', 'deleted:b.txt', 'added:c.txt', 'added:d.txt']);
  });
});

describe('5. pre-existing uncommitted changes', () => {
  it('rejecting restores the user’s uncommitted version, not HEAD', async () => {
    const root = await initRepo({ 'notes.md': 'committed\n' });
    await write(root, 'notes.md', 'committed\nuser work in progress\n');
    const h = await Harness.start(root);
    expect(await h.detect()).toEqual([]); // Pre-existing work is not a change to review.

    await write(root, 'notes.md', 'claude replaced everything\n');
    await h.rejectPath('notes.md');
    expect(await readText(root, 'notes.md')).toBe('committed\nuser work in progress\n');
  });
});

describe('6. staged and unstaged changes', () => {
  it('restores the working tree and leaves the index untouched', async () => {
    const root = await initRepo({ 'a.ts': 'v1\n', 'b.ts': 'b1\n' });
    await write(root, 'a.ts', 'v2 staged\n');
    await git(root, 'add', 'a.ts');
    await write(root, 'a.ts', 'v3 unstaged\n');
    await write(root, 'b.ts', 'b2 staged\n');
    await git(root, 'add', 'b.ts');
    const h = await Harness.start(root);
    const before = await gitState(root);

    await write(root, 'a.ts', 'claude\n');
    await h.rejectPath('a.ts');

    expect(await readText(root, 'a.ts')).toBe('v3 unstaged\n');
    expect(await readText(root, 'b.ts')).toBe('b2 staged\n');
    expect(await gitState(root)).toEqual(before);
    expect(await git(root, 'show', ':a.ts')).toBe('v2 staged\n');
  });
});

describe('7. unrelated untracked files', () => {
  it('are preserved when rejecting a new file', async () => {
    const root = await initRepo({ 'a.ts': 'a\n' });
    await write(root, 'scratch/user-notes.txt', 'mine\n');
    const h = await Harness.start(root);

    await write(root, 'scratch/claude.txt', 'generated\n');
    await h.rejectPath('scratch/claude.txt');

    expect(await readText(root, 'scratch/user-notes.txt')).toBe('mine\n');
    expect(await read(root, 'scratch/claude.txt')).toBeUndefined();
  });

  it('pre-existing untracked files can be restored after modification and deletion', async () => {
    const root = await initRepo({ 'a.ts': 'a\n' });
    await write(root, 'draft.txt', 'untracked draft\n');
    await write(root, 'todo.txt', 'untracked todo\n');
    const h = await Harness.start(root);

    await write(root, 'draft.txt', 'overwritten\n');
    await fs.rm(path.join(root, 'todo.txt'));
    await h.rejectPath('draft.txt');
    await h.rejectPath('todo.txt');

    expect(await readText(root, 'draft.txt')).toBe('untracked draft\n');
    expect(await readText(root, 'todo.txt')).toBe('untracked todo\n');
  });
});

describe('10. conflicts (early check)', () => {
  it('refuses to overwrite a file that changed after it was reviewed', async () => {
    const root = await initRepo({ 'a.ts': 'original\n' });
    const h = await Harness.start(root);

    await write(root, 'a.ts', 'claude\n');
    const reviewed = await h.change('a.ts');
    await write(root, 'a.ts', 'claude\nplus a user edit\n');

    const [result] = await h.reject(reviewed);
    expect(result?.outcome).toBe('conflict');
    expect(await readText(root, 'a.ts')).toBe('claude\nplus a user edit\n');
  });

  it('writes nothing for a rename when one half conflicts', async () => {
    const root = await initRepo({ 'old.ts': 'rename me 7\n' });
    const h = await Harness.start(root);
    await fs.rename(path.join(root, 'old.ts'), path.join(root, 'new.ts'));
    const rename = await h.change('new.ts');
    await write(root, 'old.ts', 'user recreated it\n');

    const results = await h.reject(rename);
    expect(results.map((r) => r.outcome)).toEqual(['conflict', 'skipped']);
    expect(await readText(root, 'old.ts')).toBe('user recreated it\n');
    expect(await readText(root, 'new.ts')).toBe('rename me 7\n');
  });
});

describe('12. a file that changes repeatedly', () => {
  it('keeps the original baseline and disappears when reverted', async () => {
    const root = await initRepo({ 'a.ts': 'original\n' });
    const h = await Harness.start(root);

    for (let i = 1; i <= 5; i++) {
      await write(root, 'a.ts', `edit ${i}\n`);
      const changes = await h.detect();
      expect(changes).toHaveLength(1);
      expect(changes[0]?.current.type === 'file' && changes[0].current.size).toBe(7);
    }
    await write(root, 'a.ts', 'original\n');
    expect(await h.detect()).toEqual([]);

    await write(root, 'a.ts', 'final\n');
    await h.rejectPath('a.ts');
    expect(await readText(root, 'a.ts')).toBe('original\n');
  });
});

describe('14. binary and unreadable files', () => {
  it('restores binary content byte for byte', async () => {
    const binary = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 37) % 256));
    const root = await initRepo({ 'img.bin': binary });
    const h = await Harness.start(root);
    await write(root, 'img.bin', Buffer.from([0, 1, 2]));
    await h.rejectPath('img.bin');
    expect((await read(root, 'img.bin'))?.equals(binary)).toBe(true);
  });

  it('reports unreadable files without crashing and refuses to overwrite them', async () => {
    if (process.getuid?.() === 0) {
      return; // root can read anything
    }
    const root = await initRepo({ 'secret.txt': 'x\n' });
    const h = await Harness.start(root);
    await write(root, 'secret.txt', 'changed\n');
    await fs.chmod(path.join(root, 'secret.txt'), 0o000);
    try {
      const change = await h.change('secret.txt');
      expect(change.current.type).toBe('other');
      const [result] = await h.reject(change);
      expect(result?.outcome).toBe('blocked');
    } finally {
      await fs.chmod(path.join(root, 'secret.txt'), 0o644);
    }
    expect(await readText(root, 'secret.txt')).toBe('changed\n');
  });
});

describe('commits made after the baseline', () => {
  it('still shows the change and restores the working tree without moving HEAD', async () => {
    const root = await initRepo({ 'a.ts': 'original\n' });
    const h = await Harness.start(root);
    await write(root, 'a.ts', 'claude\n');
    await git(root, 'commit', '-qam', 'claude commit');
    const head = (await git(root, 'rev-parse', 'HEAD')).trim();

    await h.rejectPath('a.ts');
    expect(await readText(root, 'a.ts')).toBe('original\n');
    expect((await git(root, 'rev-parse', 'HEAD')).trim()).toBe(head);
  });
});

describe('sensitive and oversized files', () => {
  it('detects changes but blocks rejection when bytes were not captured', async () => {
    const root = await initRepo({ 'a.ts': 'a\n' });
    await write(root, '.env', 'TOKEN=abc\n');
    await write(root, 'big.log', Buffer.alloc(2048, 1));
    const h = await Harness.start(root, { limits: { maxFileSize: 1024 } });

    const snapshots = path.join(h.store.dir);
    const stored = await fs.readdir(snapshots).catch(() => []);
    expect(stored).toEqual([]); // nothing copied

    await write(root, '.env', 'TOKEN=changed\n');
    await write(root, 'big.log', Buffer.alloc(2048, 2));
    const changes = await h.detect();
    expect(changes.map((c) => c.path)).toEqual(['.env', 'big.log']);
    for (const c of changes) {
      expect(c.restoreBlocker).toBeDefined();
      const [result] = await h.reject(c);
      expect(result?.outcome).toBe('blocked');
    }
    expect(await readText(root, '.env')).toBe('TOKEN=changed\n');
  });

  it('does not report an unchanged uncaptured file', async () => {
    const root = await initRepo({ 'a.ts': 'a\n' });
    await write(root, '.env', 'TOKEN=abc\n');
    const h = await Harness.start(root);
    expect(await h.detect()).toEqual([]);
  });
});

describe('16. without a Git repository', () => {
  it('captures a filesystem baseline and restores modify, add, and delete', async () => {
    const root = await tempDir('claude-review-plain-');
    await write(root, 'a.txt', 'alpha\n');
    await write(root, 'dir/b.txt', 'beta\n');
    await write(root, 'node_modules/pkg/index.js', 'ignored\n');
    const h = await Harness.start(root);
    expect(h.session.mode).toBe('filesystem');
    expect(Object.keys(h.session.baselines).sort()).toEqual(['a.txt', 'dir/b.txt']);

    await write(root, 'a.txt', 'changed\n');
    await write(root, 'c.txt', 'new\n');
    await fs.rm(path.join(root, 'dir/b.txt'));
    const kinds = (await h.detect()).map((c) => `${c.kind}:${c.path}`);
    expect(kinds).toEqual(['modified:a.txt', 'added:c.txt', 'deleted:dir/b.txt']);

    for (const c of await h.detect()) {
      const results = await h.reject(c);
      expect(results.every((r) => ['restored', 'removed'].includes(r.outcome))).toBe(true);
    }
    expect(await readText(root, 'a.txt')).toBe('alpha\n');
    expect(await readText(root, 'dir/b.txt')).toBe('beta\n');
    expect(await read(root, 'c.txt')).toBeUndefined();
    expect(await h.detect()).toEqual([]);
  });

  it('finds files inside a new folder when the watcher reports only the folder', async () => {
    const root = await tempDir('claude-review-plain-');
    await write(root, 'a.txt', 'alpha\n');
    const h = await Harness.start(root);
    await write(root, 'gen/deep/one.txt', '1\n');
    await write(root, 'gen/two.txt', '2\n');
    await write(root, 'gen/node_modules/x.js', 'excluded\n');
    expect((await h.detect(['gen'], false)).map((c) => c.path)).toEqual([
      'gen/deep/one.txt',
      'gen/two.txt',
    ]);
  });

  it('finds new files from watcher hints without a full scan', async () => {
    const root = await tempDir('claude-review-plain-');
    await write(root, 'a.txt', 'alpha\n');
    const h = await Harness.start(root);
    await write(root, 'new.txt', 'n\n');
    expect((await h.detect(['new.txt'], false)).map((c) => c.path)).toEqual(['new.txt']);
    // Still reported on the next run even without the hint.
    expect((await h.detect([], false)).map((c) => c.path)).toEqual(['new.txt']);
  });
});

describe('workspace folder inside a larger repository', () => {
  it('only tracks and restores paths inside the folder', async () => {
    const root = await initRepo({ 'pkg/a.ts': 'a\n', 'other/b.ts': 'b\n' });
    const h = await Harness.start(root, { folder: path.join(root, 'pkg') });
    expect(h.session.scope).toBe('pkg');

    await write(root, 'pkg/a.ts', 'changed\n');
    await write(root, 'other/b.ts', 'changed outside\n');
    expect((await h.detect()).map((c) => c.path)).toEqual(['pkg/a.ts']);

    const result = await restoreGroup(
      [{ path: 'other/b.ts', baseline: { type: 'absent' }, expected: 'absent' }],
      { session: h.session, store: h.store, git: undefined },
    );
    expect(result[0]?.outcome).toBe('blocked');
    expect(await readText(root, 'other/b.ts')).toBe('changed outside\n');
  });
});

describe('18. path traversal and writes outside the workspace', () => {
  it('blocks traversal, absolute, and .git paths', async () => {
    const root = await initRepo({ 'a.ts': 'a\n' });
    const outside = await tempDir('claude-review-outside-');
    await write(outside, 'victim.txt', 'do not touch\n');
    const h = await Harness.start(root);

    const rel = path.relative(root, path.join(outside, 'victim.txt'));
    for (const p of [rel, path.join(outside, 'victim.txt'), '.git/config', 'a/../../x']) {
      const [result] = await restoreGroup(
        [{ path: p, baseline: { type: 'absent' }, expected: stateToken({ type: 'absent' }) }],
        { session: h.session, store: h.store, git: undefined },
      );
      expect(result?.outcome, p).toBe('blocked');
    }
    expect(await readText(outside, 'victim.txt')).toBe('do not touch\n');
    expect(await readText(root, '.git/HEAD')).toContain('ref:');
  });

  it('blocks writes through a symlinked folder that points outside', async () => {
    const root = await initRepo({ 'a.ts': 'a\n' });
    const outside = await tempDir('claude-review-outside-');
    await write(outside, 'victim.txt', 'do not touch\n');
    await fs.symlink(outside, path.join(root, 'link'));
    const h = await Harness.start(root);

    const hash = await h.store.put(Buffer.from('evil\n'));
    const [result] = await restoreGroup(
      [
        {
          path: 'link/victim.txt',
          baseline: { type: 'stored', hash, size: 5, mode: 0o644 },
          expected: 'absent',
        },
      ],
      { session: h.session, store: h.store, git: undefined },
    );
    expect(result?.outcome).toBe('blocked');
    expect(await readText(outside, 'victim.txt')).toBe('do not touch\n');
  });
});

describe('8 (core). rejecting one file leaves another changed file alone', () => {
  it('only the rejected file is restored', async () => {
    const root = await initRepo({ 'a.ts': 'a\n', 'b.ts': 'b\n' });
    const h = await Harness.start(root);
    await write(root, 'a.ts', 'a changed\n');
    await write(root, 'b.ts', 'b changed\n');
    await h.rejectPath('b.ts');
    expect(await readText(root, 'a.ts')).toBe('a changed\n');
    expect(await readText(root, 'b.ts')).toBe('b\n');
    expect((await h.detect()).map((c) => c.path)).toEqual(['a.ts']);
  });
});

describe('13. large change sets', () => {
  it('detects and restores 250 changed files', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 250; i++) {
      files[`src/mod${i}/file${i}.ts`] = `export const v${i} = ${i};\n`;
    }
    const root = await initRepo(files);
    const h = await Harness.start(root);
    for (const rel of Object.keys(files)) {
      await write(root, rel, 'changed\n');
    }
    const started = Date.now();
    const changes = await h.detect();
    expect(changes).toHaveLength(250);
    expect(Date.now() - started).toBeLessThan(15000);

    for (const c of changes) {
      expect((await h.reject(c))[0]?.outcome).toBe('restored');
    }
    expect(await h.detect()).toEqual([]);
  });
});
