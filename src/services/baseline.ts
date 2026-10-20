import { randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { GlobSet } from '../core/glob';
import { inScope, relativeTo, resolveInside } from '../core/paths';
import { mapLimit } from '../core/pool';
import type { Baseline, SessionData, SessionLogEntry } from '../core/session';
import type { SnapshotStore } from '../storage/snapshotStore';
import { describeError, hashFile, isAbort, isNotFound } from './fileState';
import { Git } from './git';

export interface CaptureLimits {
  /** Files larger than this are hashed but not copied. */
  readonly maxFileSize: number;
  /** Total bytes copied per session; once exceeded, further files are hashed only. */
  readonly maxTotalSize: number;
  /** Filesystem mode refuses to snapshot workspaces with more files than this. */
  readonly maxFiles: number;
}

export interface CaptureOptions {
  readonly limits: CaptureLimits;
  /** Paths that are never tracked at all. */
  readonly exclude: GlobSet;
  /** Paths whose bytes are never copied into extension storage. */
  readonly sensitive: GlobSet;
  readonly signal?: AbortSignal;
  readonly onProgress?: (done: number, total: number) => void;
}

export class WorkspaceTooLargeError extends Error {
  constructor(readonly fileCount: number) {
    super(
      `The workspace has more than ${fileCount} files. Filesystem mode cannot snapshot it safely; ` +
        'use a Git repository or exclude large folders.',
    );
    this.name = 'WorkspaceTooLargeError';
  }
}

const CONCURRENCY = 8;

/**
 * Captures the review baseline for a workspace folder.
 *
 * Git mode records HEAD and copies the exact bytes of every path that is staged, modified,
 * deleted, or untracked right now, so uncommitted work is part of the baseline. Clean
 * tracked files are not copied: their bytes are recoverable from HEAD.
 *
 * Filesystem mode (no Git) copies every non-excluded file within the size limits.
 */
export async function captureBaseline(
  workspaceFolder: string,
  store: SnapshotStore,
  options: CaptureOptions,
  gitPath?: string,
): Promise<{ session: SessionData; git: Git | undefined }> {
  // Recorded before anything is read: edits reported by hooks with an earlier timestamp may
  // already be inside this baseline.
  const startedAt = new Date().toISOString();
  const folder = path.resolve(workspaceFolder);
  const gitRoot = await Git.findRoot(folder, gitPath);
  const root = gitRoot ?? folder;
  const scope = relativeTo(root, folder) ?? '';
  const git = gitRoot ? new Git(gitRoot, gitPath) : undefined;
  const log: SessionLogEntry[] = [];

  let head: string | null = null;
  let paths: string[];
  if (git) {
    head = await git.head(options.signal);
    const status = await git.status(scope, options.signal);
    paths = status.map((e) => e.path);
  } else {
    paths = await walkFiles(root, options.exclude, options.limits.maxFiles, options.signal);
  }
  paths = paths.filter((p) => inScope(scope, p) && !options.exclude.matches(p));

  const capturer = new WorktreeCapturer(root, store, options);
  const baselines: Record<string, Baseline> = {};
  let done = 0;
  await mapLimit(
    paths,
    CONCURRENCY,
    async (p) => {
      const baseline = await capturer.capture(p);
      baselines[p] = baseline;
      if (baseline.type === 'unavailable') {
        log.push({
          at: new Date().toISOString(),
          level: 'warning',
          path: p,
          message: baseline.reason,
        });
      }
      options.onProgress?.(++done, paths.length);
    },
    options.signal,
  );

  const session: SessionData = {
    version: 1,
    id: randomUUID(),
    createdAt: startedAt,
    workspaceFolder: folder,
    root,
    scope,
    mode: git ? 'git' : 'filesystem',
    head,
    baselines,
    log,
    reviews: {},
    history: [],
    attribution: {},
  };
  return { session, git };
}

/** Copies working-tree files into the snapshot store within the configured limits. */
export class WorktreeCapturer {
  private copiedBytes = 0;

  constructor(
    private readonly root: string,
    private readonly store: SnapshotStore,
    private readonly options: CaptureOptions,
  ) {}

  async capture(relPath: string): Promise<Baseline> {
    const abs = resolveInside(this.root, relPath);
    const { signal } = this.options;
    try {
      const stat = await fs.lstat(abs);
      if (stat.isSymbolicLink()) {
        return { type: 'unavailable', reason: 'symbolic links are not snapshotted' };
      }
      if (!stat.isFile()) {
        return { type: 'unavailable', reason: 'not a regular file' };
      }
      const mode = stat.mode & 0o777;
      const hashOnly = async (reason: string): Promise<Baseline> => ({
        type: 'unavailable',
        reason,
        hash: await hashFile(abs, signal),
        size: stat.size,
      });

      if (this.options.sensitive.matches(relPath)) {
        return await hashOnly('matches a sensitive-file pattern, so its content was not copied');
      }
      if (stat.size > this.options.limits.maxFileSize) {
        return await hashOnly(
          `larger than the ${formatBytes(this.options.limits.maxFileSize)} snapshot limit`,
        );
      }
      if (this.copiedBytes + stat.size > this.options.limits.maxTotalSize) {
        return await hashOnly(
          `session snapshot budget of ${formatBytes(this.options.limits.maxTotalSize)} reached`,
        );
      }
      this.copiedBytes += stat.size;
      const data = await fs.readFile(abs, signal ? { signal } : {});
      const hash = await this.store.put(data);
      return { type: 'stored', hash, size: data.length, mode };
    } catch (e) {
      if (isAbort(e)) {
        throw e;
      }
      if (isNotFound(e)) {
        return { type: 'absent' };
      }
      return { type: 'unavailable', reason: `could not be read (${describeError(e)})` };
    }
  }
}

/** Lists root-relative file paths, skipping excluded paths. Symlinks are listed, not followed. */
export async function walkFiles(
  root: string,
  exclude: GlobSet,
  maxFiles: number,
  signal?: AbortSignal,
): Promise<string[]> {
  const result: string[] = [];
  const queue: string[] = [''];
  for (let dir = queue.pop(); dir !== undefined; dir = queue.pop()) {
    signal?.throwIfAborted();
    let entries: Dirent[];
    try {
      entries = await fs.readdir(path.join(root, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const rel = dir === '' ? entry.name : `${dir}/${entry.name}`;
      if (entry.name === '.git' || exclude.matches(rel)) {
        continue;
      }
      if (entry.isDirectory()) {
        queue.push(rel);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        result.push(rel);
        if (result.length > maxFiles) {
          throw new WorkspaceTooLargeError(maxFiles);
        }
      }
    }
  }
  return result;
}

export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) {
    return `${Math.round(n / (1024 * 1024))} MB`;
  }
  if (n >= 1024) {
    return `${Math.round(n / 1024)} KB`;
  }
  return `${n} bytes`;
}
