import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GlobSet } from '../../core/glob';
import { acceptMany, isCompleteSuccess, rejectMany, undoLast } from '../../services/actions';
import { cleanupTempDirs, git, Harness, initRepo, readText, write } from './helpers/workspace';

afterEach(cleanupTempDirs);

/** Generous bounds: these guard against pathological slowness, not micro-benchmarks. */
const CAPTURE_BUDGET_MS = 15_000;
const DETECT_BUDGET_MS = 15_000;

describe('13. large workspaces', () => {
  it('5,000 tracked files, pre-existing work, and 300 changes of every kind', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 5000; i++) {
      files[`pkg${i % 50}/dir${i % 7}/file${i}.ts`] = `export const v${i} = ${i};\n`;
    }
    files['.gitignore'] = 'node_modules/\ndist/\n';
    const root = await initRepo(files);

    // Pre-existing user work: 40 modified, 20 untracked, plus an ignored build tree.
    for (let i = 0; i < 40; i++) {
      await write(root, `pkg${i % 50}/dir${i % 7}/file${i}.ts`, `user edit ${i}\n`);
    }
    for (let i = 0; i < 20; i++) {
      await write(root, `scratch/user${i}.txt`, `user untracked ${i}\n`);
    }
    for (let i = 0; i < 500; i++) {
      await write(root, `node_modules/dep${i % 10}/f${i}.js`, 'x');
    }

    let started = Date.now();
    const h = await Harness.start(root);
    const captureMs = Date.now() - started;
    expect(captureMs).toBeLessThan(CAPTURE_BUDGET_MS);
    expect(Object.keys(h.session.baselines)).toHaveLength(60); // only dirty/untracked are copied

    // "Claude": 200 modifications, 50 new files, 30 deletions, 20 renames.
    for (let i = 1000; i < 1200; i++) {
      await write(root, `pkg${i % 50}/dir${i % 7}/file${i}.ts`, `claude ${i}\n`);
    }
    for (let i = 0; i < 50; i++) {
      await write(root, `generated/new${i}.ts`, `new ${i}\n`);
    }
    for (let i = 2000; i < 2030; i++) {
      await fs.rm(path.join(root, `pkg${i % 50}/dir${i % 7}/file${i}.ts`));
    }
    await fs.mkdir(path.join(root, 'moved'));
    for (let i = 3000; i < 3020; i++) {
      await fs.rename(
        path.join(root, `pkg${i % 50}/dir${i % 7}/file${i}.ts`),
        path.join(root, `moved/file${i}.ts`),
      );
    }

    started = Date.now();
    const changes = await h.detect();
    const detectMs = Date.now() - started;
    expect(detectMs).toBeLessThan(DETECT_BUDGET_MS);
    const count = (kind: string): number => changes.filter((c) => c.kind === kind).length;
    expect([count('modified'), count('added'), count('deleted'), count('renamed')]).toEqual([
      200, 50, 30, 20,
    ]);

    // A second detection with nothing new is faster thanks to the stat cache (no assertion on
    // exact timing, only that it completes and agrees).
    expect(await h.detect()).toHaveLength(300);

    const deps = {
      session: h.session,
      store: h.store,
      git: h.git,
      sensitive: new GlobSet([]),
      limits: h.limits,
    };
    started = Date.now();
    const report = await rejectMany(changes, deps);
    const rejectMs = Date.now() - started;
    expect(isCompleteSuccess(report)).toBe(true);
    expect(report.succeeded).toHaveLength(300);
    expect(await h.detect()).toEqual([]);

    // Pre-existing user work is untouched.
    expect(await readText(root, 'pkg0/dir0/file0.ts')).toBe('user edit 0\n');
    expect(await readText(root, 'scratch/user7.txt')).toBe('user untracked 7\n');
    const status = await git(root, 'status', '--porcelain');
    expect(status.split('\n').filter(Boolean)).toHaveLength(41); // 40 modified + 1 untracked dir

    // Undo the whole batch, then accept everything.
    const undone = await undoLast(deps);
    expect(undone?.succeeded).toHaveLength(300);
    const again = await h.detect();
    expect(again).toHaveLength(300);
    const accepted = await acceptMany(again, deps);
    expect(accepted.succeeded).toHaveLength(300);
    expect(await h.detect()).toEqual([]);

    console.info(
      `scale: capture ${captureMs} ms, detect ${detectMs} ms, reject 300 files ${rejectMs} ms`,
    );
  }, 120_000);
});
