import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GlobSet } from '../../core/glob';
import { referencedHashes, type SessionData } from '../../core/session';
import {
  acceptMany,
  isCompleteSuccess,
  rejectMany,
  undoLast,
  type ActionDeps,
} from '../../services/actions';
import { ChangeTracker } from '../../services/changeTracker';
import { Git } from '../../services/git';
import { applyRetention } from '../../storage/retention';
import { SessionStore } from '../../storage/sessionStore';
import { SnapshotStore } from '../../storage/snapshotStore';
import {
  cleanupTempDirs,
  DEFAULT_LIMITS,
  git,
  Harness,
  initRepo,
  read,
  readText,
  tempDir,
  write,
} from './helpers/workspace';

afterEach(cleanupTempDirs);

function deps(h: Harness): ActionDeps {
  return {
    session: h.session,
    store: h.store,
    git: h.git,
    sensitive: new GlobSet(['.env']),
    limits: h.limits,
  };
}

/** A repository with pre-existing user work plus one change of every kind made "by Claude". */
async function busyRepo(): Promise<{ root: string; h: Harness }> {
  const root = await initRepo({
    'mod.ts': 'mod original\n',
    'del.ts': 'delete me\n',
    'ren-old.ts': 'rename me 123\n',
    'user.ts': 'user committed\n',
  });
  await write(root, 'user.ts', 'user committed\nuser uncommitted\n');
  await write(root, 'scratch.txt', 'user untracked\n');
  await git(root, 'add', 'user.ts');
  await write(root, 'user.ts', 'user committed\nuser uncommitted\nuser unstaged\n');
  const h = await Harness.start(root);

  await write(root, 'mod.ts', 'mod by claude\n');
  await fs.rm(path.join(root, 'del.ts'));
  await fs.rename(path.join(root, 'ren-old.ts'), path.join(root, 'ren-new.ts'));
  await write(root, 'added/new.ts', 'new by claude\n');
  return { root, h };
}

async function expectUserWorkIntact(root: string): Promise<void> {
  expect(await readText(root, 'user.ts')).toBe('user committed\nuser uncommitted\nuser unstaged\n');
  expect(await readText(root, 'scratch.txt')).toBe('user untracked\n');
  expect(await git(root, 'show', ':user.ts')).toBe('user committed\nuser uncommitted\n');
}

describe('9. Accept All and Reject All', () => {
  it('Reject All restores every kind of change and keeps unrelated user work', async () => {
    const { root, h } = await busyRepo();
    const changes = await h.detect();
    expect(changes.map((c) => `${c.kind}:${c.path}`)).toEqual([
      'added:added/new.ts',
      'deleted:del.ts',
      'modified:mod.ts',
      'renamed:ren-new.ts',
    ]);

    const report = await rejectMany(changes, deps(h));
    expect(isCompleteSuccess(report)).toBe(true);
    expect(report.succeeded).toHaveLength(4);

    expect(await readText(root, 'mod.ts')).toBe('mod original\n');
    expect(await readText(root, 'del.ts')).toBe('delete me\n');
    expect(await readText(root, 'ren-old.ts')).toBe('rename me 123\n');
    expect(await read(root, 'ren-new.ts')).toBeUndefined();
    expect(await read(root, 'added/new.ts')).toBeUndefined();
    await expectUserWorkIntact(root);
    expect(await h.detect()).toEqual([]);
    expect(h.session.history).toHaveLength(1);
    expect(h.session.history[0]?.items).toHaveLength(4);
  });

  it('Accept All keeps every file as it is', async () => {
    const { root, h } = await busyRepo();
    const report = await acceptMany(await h.detect(), deps(h));
    expect(report.succeeded).toHaveLength(4);
    expect(await readText(root, 'mod.ts')).toBe('mod by claude\n');
    expect(await read(root, 'del.ts')).toBeUndefined();
    expect(await readText(root, 'added/new.ts')).toBe('new by claude\n');
    await expectUserWorkIntact(root);
    expect(await h.detect()).toEqual([]);
  });

  it('reports partial results precisely and records only what succeeded', async () => {
    const root = await initRepo({ 'a.ts': 'a\n', 'b.ts': 'b\n', 'c.ts': 'c\n' });
    await write(root, '.env', 'SECRET=1\n');
    const h = await Harness.start(root);
    await write(root, 'a.ts', 'a2\n');
    await write(root, 'b.ts', 'b2\n');
    await write(root, 'c.ts', 'c2\n');
    await write(root, '.env', 'SECRET=2\n');
    const changes = await h.detect();
    await write(root, 'b.ts', 'b3 user edit after review\n');

    const report = await rejectMany(changes, deps(h));
    expect(report.succeeded.sort()).toEqual(['a.ts', 'c.ts']);
    expect(report.conflicts.map((i) => i.key)).toEqual(['b.ts']);
    expect(report.blocked.map((i) => i.key)).toEqual(['.env']);
    expect(isCompleteSuccess(report)).toBe(false);
    expect(await readText(root, 'b.ts')).toBe('b3 user edit after review\n');
    expect(await readText(root, '.env')).toBe('SECRET=2\n');
    expect(
      h.session.history
        .at(-1)
        ?.items.map((i) => i.key)
        .sort(),
    ).toEqual(['a.ts', 'c.ts']);
  });

  it('stops when cancelled and lists what was not attempted', async () => {
    const root = await initRepo({ 'a.ts': 'a\n', 'b.ts': 'b\n', 'c.ts': 'c\n' });
    const h = await Harness.start(root);
    for (const f of ['a.ts', 'b.ts', 'c.ts']) {
      await write(root, f, 'changed\n');
    }
    const abort = new AbortController();
    const report = await rejectMany(await h.detect(), deps(h), {
      signal: abort.signal,
      onProgress: (done) => {
        if (done === 1) {
          abort.abort();
        }
      },
    });
    expect(report.succeeded).toEqual(['a.ts', 'b.ts']);
    expect(report.cancelled).toEqual(['c.ts']);
    expect(await readText(root, 'c.ts')).toBe('changed\n');
  });
});

describe('undo', () => {
  it('undoing Reject All writes every rejected change back', async () => {
    const { root, h } = await busyRepo();
    await rejectMany(await h.detect(), deps(h));
    const report = await undoLast(deps(h));
    expect(report && isCompleteSuccess(report)).toBe(true);

    expect(await readText(root, 'mod.ts')).toBe('mod by claude\n');
    expect(await read(root, 'del.ts')).toBeUndefined();
    expect(await readText(root, 'ren-new.ts')).toBe('rename me 123\n');
    expect(await read(root, 'ren-old.ts')).toBeUndefined();
    expect(await readText(root, 'added/new.ts')).toBe('new by claude\n');
    await expectUserWorkIntact(root);
    expect(h.session.history).toEqual([]);
    expect(h.session.reviews).toEqual({});
    expect((await h.detect()).map((c) => c.kind).sort()).toEqual([
      'added',
      'deleted',
      'modified',
      'renamed',
    ]);
  });

  it('undoing an accept touches no file and makes it pending again', async () => {
    const root = await initRepo({ 'a.ts': 'a\n' });
    const h = await Harness.start(root);
    await write(root, 'a.ts', 'a2\n');
    await acceptMany(await h.detect(), deps(h));
    expect(await h.detect()).toEqual([]);

    await undoLast(deps(h));
    expect(await readText(root, 'a.ts')).toBe('a2\n');
    expect((await h.detect()).map((c) => c.path)).toEqual(['a.ts']);
  });

  it('restores an earlier decision when undoing a later one', async () => {
    const root = await initRepo({ 'a.ts': 'v1\n' });
    const h = await Harness.start(root);
    await write(root, 'a.ts', 'v2\n');
    await acceptMany(await h.detect(), deps(h));
    await write(root, 'a.ts', 'v3\n');
    await rejectMany(await h.detect(), deps(h));
    expect(h.session.reviews['a.ts']?.status).toBe('rejected');

    await undoLast(deps(h));
    expect(await readText(root, 'a.ts')).toBe('v3\n');
    expect(h.session.reviews['a.ts']?.status).toBe('accepted');
  });

  it('refuses to undo a reject over a file edited since, and keeps it undoable', async () => {
    const root = await initRepo({ 'a.ts': 'a\n', 'b.ts': 'b\n' });
    const h = await Harness.start(root);
    await write(root, 'a.ts', 'a by claude\n');
    await write(root, 'b.ts', 'b by claude\n');
    await rejectMany(await h.detect(), deps(h));
    await write(root, 'b.ts', 'b user edit after reject\n');

    const report = await undoLast(deps(h));
    expect(report?.succeeded).toEqual(['a.ts']);
    expect(report?.conflicts.map((i) => i.key)).toEqual(['b.ts']);
    expect(await readText(root, 'a.ts')).toBe('a by claude\n');
    expect(await readText(root, 'b.ts')).toBe('b user edit after reject\n');
    expect(h.session.history[0]?.items.map((i) => i.key)).toEqual(['b.ts']);
  });

  it('returns undefined when there is nothing to undo', async () => {
    const root = await initRepo({ 'a.ts': 'a\n' });
    const h = await Harness.start(root);
    expect(await undoLast(deps(h))).toBeUndefined();
  });
});

describe('11. recovering review state after a restart', () => {
  it('a reloaded session detects the same changes and can still reject and undo', async () => {
    const root = await initRepo({ 'a.ts': 'original\n', 'b.ts': 'b\n' });
    await write(root, 'a.ts', 'original\nuncommitted\n');
    const h = await Harness.start(root);
    const storage = await tempDir();
    const sessions = new SessionStore(storage);

    await write(root, 'a.ts', 'claude\n');
    await write(root, 'b.ts', 'b2\n');
    await acceptMany(
      (await h.detect()).filter((c) => c.path === 'b.ts'),
      deps(h),
    );
    await sessions.save(h.session);
    await sessions.setActive(h.session.id);

    // "Restart": nothing in memory survives except the files on disk.
    const loaded = await sessions.loadActive();
    if (!loaded) {
      throw new Error('session not reloaded');
    }
    expect(loaded.reviews['b.ts']?.status).toBe('accepted');
    const tracker = new ChangeTracker(loaded, new Git(root), new GlobSet([]), DEFAULT_LIMITS);
    const { changes } = await tracker.detect();
    expect(changes.map((c) => c.path)).toEqual(['a.ts']);

    const reloadedDeps: ActionDeps = { ...deps(h), session: loaded };
    await rejectMany(changes, reloadedDeps);
    expect(await readText(root, 'a.ts')).toBe('original\nuncommitted\n');
    await sessions.save(loaded);

    const again = await sessions.loadActive();
    if (!again) {
      throw new Error('session not reloaded');
    }
    expect(again.history).toHaveLength(2);
    await undoLast({ ...reloadedDeps, session: again });
    expect(await readText(root, 'a.ts')).toBe('claude\n');
  });
});

describe('retention', () => {
  function fakeSession(id: string, createdAt: string, hash?: string): SessionData {
    return {
      version: 1,
      id,
      createdAt,
      workspaceFolder: '/w',
      root: '/w',
      scope: '',
      mode: 'filesystem',
      head: null,
      baselines: hash ? { 'f.txt': { type: 'stored', hash, size: 1, mode: 0o644 } } : {},
      log: [],
      reviews: {},
      history: [],
    };
  }

  it('keeps the active session and the newest ended ones, and frees their snapshots', async () => {
    const storage = await tempDir();
    const sessions = new SessionStore(storage);
    const snapshots = new SnapshotStore(path.join(storage, 'snapshots'));
    const now = Date.parse('2026-10-20T00:00:00Z');
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) {
      const hash = await snapshots.put(Buffer.from(`content ${i}`));
      const id = `s${i}`;
      ids.push(id);
      const day = String(10 + i).padStart(2, '0');
      await sessions.save(fakeSession(id, `2026-10-${day}T00:00:00Z`, hash));
    }
    // The oldest session is active and must survive regardless of age or count.
    const result = await applyRetention(
      sessions,
      snapshots,
      { maxSessions: 3, maxAgeDays: 30 },
      's0',
      now,
    );
    expect(result.sessionsDeleted).toBe(4);
    expect((await sessions.list()).map((s) => s.id).sort()).toEqual(['s0', 's5', 's6', 's7']);
    expect(result.snapshotsDeleted).toBe(4);
  });

  it('deletes ended sessions older than the age limit', async () => {
    const storage = await tempDir();
    const sessions = new SessionStore(storage);
    const snapshots = new SnapshotStore(path.join(storage, 'snapshots'));
    await sessions.save(fakeSession('old', '2026-01-01T00:00:00Z'));
    await sessions.save(fakeSession('new', '2026-10-19T00:00:00Z'));
    await applyRetention(
      sessions,
      snapshots,
      { maxSessions: 10, maxAgeDays: 30 },
      undefined,
      Date.parse('2026-10-20T00:00:00Z'),
    );
    expect((await sessions.list()).map((s) => s.id)).toEqual(['new']);
  });

  it('counts snapshots referenced from history as in use', async () => {
    const root = await initRepo({ 'a.ts': 'a\n' });
    const h = await Harness.start(root);
    await write(root, 'a.ts', 'a2\n');
    await rejectMany(await h.detect(), deps(h));
    const record = h.session.history[0]?.items[0]?.record;
    expect(record?.after.type).toBe('stored');
    if (record?.after.type === 'stored') {
      expect(referencedHashes(h.session).has(record.after.hash)).toBe(true);
    }
  });
});
