import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isBinary } from '../../core/content';
import { GlobSet } from '../../core/glob';
import type { DetectedChange } from '../../core/session';
import { readBaselineBytes } from '../../services/restore';
import {
  acceptChange,
  rejectChange,
  type AcceptResult,
  type RejectOutcome,
} from '../../services/review';
import {
  cleanupTempDirs,
  git,
  Harness,
  initRepo,
  read,
  readText,
  write,
} from './helpers/workspace';

afterEach(cleanupTempDirs);

async function accept(h: Harness, change: DetectedChange): Promise<AcceptResult> {
  return acceptChange(change, {
    session: h.session,
    store: h.store,
    sensitive: new GlobSet(['.env']),
    limits: h.limits,
  });
}

async function reject(h: Harness, change: DetectedChange): Promise<RejectOutcome> {
  return rejectChange(change, { session: h.session, store: h.store, git: h.git });
}

describe('8. accepting one file while rejecting another', () => {
  it('keeps the accepted file, restores the rejected one, and records both', async () => {
    const root = await initRepo({ 'a.ts': 'a\n', 'b.ts': 'b\n' });
    const h = await Harness.start(root);
    await write(root, 'a.ts', 'a by claude\n');
    await write(root, 'b.ts', 'b by claude\n');

    const accepted = await accept(h, await h.change('a.ts'));
    expect(accepted.ok).toBe(true);
    const rejected = await reject(h, await h.change('b.ts'));
    expect(rejected.record?.status).toBe('rejected');

    expect(await readText(root, 'a.ts')).toBe('a by claude\n');
    expect(await readText(root, 'b.ts')).toBe('b\n');
    expect(await h.detect()).toEqual([]);
    expect(Object.keys(h.session.reviews).sort()).toEqual(['a.ts', 'b.ts']);
    expect(h.session.reviews['a.ts']?.status).toBe('accepted');
    // Accept never commits or stages anything: a.ts is still an unstaged modification.
    expect(await git(root, 'status', '--porcelain')).toBe(' M a.ts\n');
  });
});

describe('accept', () => {
  it('moves the baseline forward so later edits are pending against the accepted version', async () => {
    const root = await initRepo({ 'a.ts': 'v1\n' });
    const h = await Harness.start(root);
    await write(root, 'a.ts', 'v2\n');
    expect((await accept(h, await h.change('a.ts'))).ok).toBe(true);
    expect(await h.detect()).toEqual([]);

    await write(root, 'a.ts', 'v3\n');
    const again = await h.change('a.ts');
    expect(again.kind).toBe('modified');
    const outcome = await reject(h, again);
    expect(outcome.record).toBeDefined();
    expect(await readText(root, 'a.ts')).toBe('v2\n');
  });

  it('refuses when the file changed after it was reviewed', async () => {
    const root = await initRepo({ 'a.ts': 'v1\n' });
    const h = await Harness.start(root);
    await write(root, 'a.ts', 'v2\n');
    const reviewed = await h.change('a.ts');
    await write(root, 'a.ts', 'v2 plus something unseen\n');

    const result = await accept(h, reviewed);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('conflict');
    expect(h.session.reviews).toEqual({});
    expect((await h.change('a.ts')).kind).toBe('modified');
  });

  it('accepts additions, deletions, and renames without touching files', async () => {
    const root = await initRepo({ 'gone.ts': 'bye\n', 'old.ts': 'move me 99\n' });
    const h = await Harness.start(root);
    await write(root, 'added.ts', 'new\n');
    await fs.rm(path.join(root, 'gone.ts'));
    await fs.rename(path.join(root, 'old.ts'), path.join(root, 'new.ts'));

    for (const change of await h.detect()) {
      expect((await accept(h, change)).ok).toBe(true);
    }
    expect(await h.detect()).toEqual([]);
    expect(await readText(root, 'added.ts')).toBe('new\n');
    expect(await read(root, 'gone.ts')).toBeUndefined();
    expect(await readText(root, 'new.ts')).toBe('move me 99\n');
    expect(h.session.reviews['new.ts']).toMatchObject({ kind: 'renamed', oldPath: 'old.ts' });
  });

  it('does not copy sensitive files but still detects later edits', async () => {
    const root = await initRepo({ 'a.ts': 'a\n' });
    const h = await Harness.start(root);
    await write(root, '.env', 'KEY=1\n');
    expect((await accept(h, await h.change('.env'))).ok).toBe(true);
    expect(h.session.baselines['.env']?.type).toBe('unavailable');
    expect(await h.detect()).toEqual([]);

    await write(root, '.env', 'KEY=2\n');
    const later = await h.change('.env');
    expect(later.restoreBlocker).toBeDefined();
  });
});

describe('reject records', () => {
  it('keeps a verified backup of the rejected content', async () => {
    const root = await initRepo({ 'a.ts': 'original\n' });
    const h = await Harness.start(root);
    await write(root, 'a.ts', 'rejected content\n');
    const { record } = await reject(h, await h.change('a.ts'));
    if (!record) {
      throw new Error('expected a record');
    }
    expect(record.after.type).toBe('stored');
    const bytes = await readBaselineBytes(record.after, 'a.ts', h.store, undefined);
    expect(bytes?.toString()).toBe('rejected content\n');
  });

  it('records nothing when the reject did not happen', async () => {
    const root = await initRepo({ 'a.ts': 'original\n' });
    const h = await Harness.start(root);
    await write(root, 'a.ts', 'claude\n');
    const reviewed = await h.change('a.ts');
    await write(root, 'a.ts', 'user edit\n');
    const outcome = await reject(h, reviewed);
    expect(outcome.record).toBeUndefined();
    expect(outcome.results[0]?.outcome).toBe('conflict');
    expect(h.session.reviews).toEqual({});
  });
});

describe('isBinary', () => {
  it('detects NUL bytes in the first 8000 bytes only', () => {
    expect(isBinary(Buffer.from('plain text\n'))).toBe(false);
    expect(isBinary(Buffer.from([0x50, 0x00, 0x4b]))).toBe(true);
    const late = Buffer.alloc(9000, 0x41);
    late[8500] = 0;
    expect(isBinary(late)).toBe(false);
  });
});
