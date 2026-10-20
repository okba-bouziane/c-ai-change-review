import { createHash } from 'node:crypto';
import { createReadStream, type Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import type { CurrentState, Sha256 } from '../core/session';

export function sha256(data: Buffer): Sha256 {
  return createHash('sha256').update(data).digest('hex');
}

export async function hashFile(abs: string, signal?: AbortSignal): Promise<Sha256> {
  const hash = createHash('sha256');
  const stream = createReadStream(abs, signal ? { signal } : {});
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

/** Reads a path's current state without following symlinks. Never throws for I/O errors. */
export async function readCurrentState(abs: string, signal?: AbortSignal): Promise<CurrentState> {
  let stat: Stats;
  try {
    stat = await fs.lstat(abs);
  } catch (e) {
    return isNotFound(e) ? { type: 'absent' } : { type: 'other', reason: describeError(e) };
  }
  if (stat.isSymbolicLink()) {
    return { type: 'other', reason: 'symbolic link' };
  }
  if (!stat.isFile()) {
    return { type: 'other', reason: stat.isDirectory() ? 'directory' : 'not a regular file' };
  }
  try {
    return {
      type: 'file',
      hash: await hashFile(abs, signal),
      size: stat.size,
      mode: stat.mode & 0o777,
    };
  } catch (e) {
    if (isAbort(e)) {
      throw e;
    }
    return isNotFound(e) ? { type: 'absent' } : { type: 'other', reason: describeError(e) };
  }
}

interface CacheEntry {
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly ino: number;
  readonly state: CurrentState;
}

/**
 * Avoids re-hashing files whose stat data is unchanged. Entries are only trusted when the
 * file's mtime is comfortably in the past, so a write landing in the same timestamp tick
 * as the hash (the classic "racy git" problem) is always re-read.
 */
export class FileStateCache {
  private static readonly RACY_WINDOW_MS = 2000;
  private readonly entries = new Map<string, CacheEntry>();

  async read(abs: string, signal?: AbortSignal): Promise<CurrentState> {
    let stat: Stats | undefined;
    try {
      stat = await fs.lstat(abs);
    } catch {
      stat = undefined;
    }
    const cached = this.entries.get(abs);
    if (stat?.isFile() && cached && sameStat(cached, stat)) {
      return cached.state;
    }
    const startedAt = Date.now();
    const state = await readCurrentState(abs, signal);
    if (
      stat?.isFile() &&
      state.type === 'file' &&
      startedAt - stat.mtimeMs > FileStateCache.RACY_WINDOW_MS
    ) {
      this.entries.set(abs, {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
        ino: stat.ino,
        state,
      });
    } else {
      this.entries.delete(abs);
    }
    return state;
  }

  invalidate(abs: string): void {
    this.entries.delete(abs);
  }

  clear(): void {
    this.entries.clear();
  }
}

function sameStat(a: CacheEntry, b: Stats): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.ino === b.ino;
}

export function isNotFound(e: unknown): boolean {
  const code = (e as { code?: unknown } | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

export function isAbort(e: unknown): boolean {
  return (e as { name?: unknown } | undefined)?.name === 'AbortError';
}

export function describeError(e: unknown): string {
  const code = (e as { code?: unknown } | undefined)?.code;
  if (code === 'EACCES' || code === 'EPERM') {
    return 'permission denied';
  }
  return e instanceof Error ? e.message : String(e);
}
