import { afterEach, describe, expect, it } from 'vitest';
import { GlobSet } from '../../core/glob';
import { normalizeRelPath, UnsafePathError } from '../../core/paths';
import { classify, pairRenames, type DetectedChange } from '../../core/session';
import { sha256 } from '../../services/fileState';
import { assertReadOnly, Git, parseStatusV2 } from '../../services/git';
import { SnapshotIntegrityError, SnapshotStore } from '../../storage/snapshotStore';
import { SessionStore } from '../../storage/sessionStore';
import { cleanupTempDirs, initRepo, tempDir, write } from './helpers/workspace';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

afterEach(cleanupTempDirs);

describe('normalizeRelPath', () => {
  it('normalizes safe paths', () => {
    expect(normalizeRelPath('./a//b/./c.ts')).toBe('a/b/c.ts');
    expect(normalizeRelPath('a\\b.ts')).toBe('a/b.ts');
  });

  it.each(['', '.', '../x', 'a/../../x', '/etc/passwd', 'C:/x', '.git/config', 'a/.GIT/x', 'a\0b'])(
    'rejects %j',
    (p) => {
      expect(() => normalizeRelPath(p)).toThrow(UnsafePathError);
    },
  );
});

describe('GlobSet', () => {
  const set = new GlobSet(['**/node_modules/**', '.env', '.env.*', '*.pem', 'build/', 'docs/*.md']);
  it.each([
    ['node_modules/a/b.js', true],
    ['pkg/node_modules/x', true],
    ['.env', true],
    ['config/.env.local', true],
    ['keys/server.pem', true],
    ['docs/readme.md', true],
    ['docs/deep/readme.md', false],
    ['src/env.ts', false],
    ['src/app.ts', false],
  ])('%s → %s', (p, expected) => {
    expect(set.matches(p)).toBe(expected);
  });
});

describe('classify', () => {
  const file = { type: 'file', hash: 'h1', size: 1, mode: 0o644 } as const;
  it('covers every combination', () => {
    expect(classify({ type: 'absent' }, { type: 'absent' })).toBeUndefined();
    expect(classify({ type: 'absent' }, file)).toBe('added');
    expect(classify({ type: 'stored', hash: 'h1', size: 1, mode: 0o644 }, file)).toBeUndefined();
    expect(classify({ type: 'stored', hash: 'h0', size: 1, mode: 0o644 }, file)).toBe('modified');
    expect(classify({ type: 'stored', hash: 'h1', size: 1, mode: 0o755 }, file)).toBe('modified');
    expect(classify({ type: 'git', blob: 'b', mode: 0o644, hash: 'h1' }, { type: 'absent' })).toBe(
      'deleted',
    );
    expect(classify({ type: 'unavailable', reason: 'r', hash: 'h1' }, file)).toBeUndefined();
    expect(classify({ type: 'unavailable', reason: 'r' }, file)).toBe('modified');
  });
});

describe('pairRenames', () => {
  const del = (p: string, hash: string): DetectedChange => ({
    path: p,
    kind: 'deleted',
    baseline: { type: 'stored', hash, size: 1, mode: 0o644 },
    current: { type: 'absent' },
  });
  const add = (p: string, hash: string): DetectedChange => ({
    path: p,
    kind: 'added',
    baseline: { type: 'absent' },
    current: { type: 'file', hash, size: 1, mode: 0o644 },
  });

  it('pairs unique matches only', () => {
    const result = pairRenames([del('a', 'x'), add('b', 'x'), del('c', 'y'), add('d', 'z')]);
    expect(result.map((c) => `${c.kind}:${c.oldPath ?? ''}>${c.path}`).sort()).toEqual([
      'added:>d',
      'deleted:>c',
      'renamed:a>b',
    ]);
  });
});

describe('Git command guard', () => {
  it.each([['reset', '--hard'], ['checkout', '.'], ['clean', '-fd'], ['stash'], ['add', '-A'], []])(
    'refuses git %j',
    (...args) => {
      expect(() => {
        assertReadOnly(args);
      }).toThrow(/non-read-only/);
    },
  );

  it('allows read-only commands', () => {
    expect(() => {
      assertReadOnly(['status', '--porcelain=v2']);
    }).not.toThrow();
  });
});

describe('parseStatusV2', () => {
  it('parses tracked, unmerged, and untracked entries including spaces', () => {
    const out = [
      '1 .M N... 100644 100644 100644 abc abc src/my file.ts',
      'u UU N... 100644 100644 100644 100644 a b c conflict me.txt',
      '? new dir/new file.txt',
      '',
    ].join('\0');
    expect(parseStatusV2(out)).toEqual([
      { path: 'src/my file.ts', type: 'tracked' },
      { path: 'conflict me.txt', type: 'unmerged' },
      { path: 'new dir/new file.txt', type: 'untracked' },
    ]);
  });

  it('round-trips real git output for unusual names', async () => {
    const root = await initRepo({ 'normal.ts': 'n\n' });
    await write(root, 'spaced name.ts', 'x');
    await write(root, 'ünïcödé/файл.ts', 'x');
    const git = new Git(root);
    const paths = (await git.status('')).map((e) => e.path).sort();
    expect(paths).toEqual(['spaced name.ts', 'ünïcödé/файл.ts']);
  });
});

describe('SnapshotStore', () => {
  it('stores, deduplicates, verifies, and garbage-collects', async () => {
    const dir = await tempDir();
    const store = new SnapshotStore(dir);
    const a = await store.put(Buffer.from('a'));
    expect(await store.put(Buffer.from('a'))).toBe(a);
    expect(a).toBe(sha256(Buffer.from('a')));
    expect((await store.get(a)).toString()).toBe('a');

    const b = await store.put(Buffer.from('b'));
    await fs.writeFile(path.join(dir, b.slice(0, 2), b.slice(2)), 'tampered');
    await expect(store.get(b)).rejects.toBeInstanceOf(SnapshotIntegrityError);

    expect(await store.collectGarbage(new Set([a]))).toBe(1);
    expect(await store.has(a)).toBe(true);
    expect(await store.has(b)).toBe(false);
  });

  it('keeps snapshot files private to the user', async () => {
    const store = new SnapshotStore(await tempDir());
    const h = await store.put(Buffer.from('secret-ish'));
    const stat = await fs.stat(path.join(store.dir, h.slice(0, 2), h.slice(2)));
    expect(stat.mode & 0o077).toBe(0);
  });
});

describe('SessionStore', () => {
  it('persists and reloads the active session', async () => {
    const store = new SessionStore(await tempDir());
    expect(await store.loadActive()).toBeUndefined();
    const session = {
      version: 1,
      id: 'abc-123',
      createdAt: new Date().toISOString(),
      workspaceFolder: '/w',
      root: '/w',
      scope: '',
      mode: 'git',
      head: null,
      baselines: { 'a.ts': { type: 'absent' } },
      log: [],
    } as const;
    // Written without `reviews`, like a session saved by an earlier version.
    await store.save({ ...session, baselines: { ...session.baselines }, log: [] } as never);
    await store.setActive('abc-123');
    expect(await store.loadActive()).toEqual({ ...session, reviews: {}, history: [] });
    await expect(store.load('../evil')).rejects.toThrow(/Invalid session id/);
  });
});
