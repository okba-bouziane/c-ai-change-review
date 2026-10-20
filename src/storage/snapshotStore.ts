import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Sha256 } from '../core/session';
import { isNotFound, sha256 } from '../services/fileState';

export class SnapshotIntegrityError extends Error {
  constructor(readonly hash: Sha256) {
    super(`Snapshot ${hash} is missing or corrupted`);
    this.name = 'SnapshotIntegrityError';
  }
}

/**
 * Content-addressed blob store for original file bytes. Blobs are named by their SHA-256,
 * written atomically, readable only by the current user, and verified on every read.
 * The store lives in VS Code's extension storage, never inside the workspace.
 */
export class SnapshotStore {
  constructor(readonly dir: string) {}

  async put(data: Buffer): Promise<Sha256> {
    const hash = sha256(data);
    const target = this.pathFor(hash);
    if (await exists(target)) {
      return hash;
    }
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await fs.writeFile(temp, data, { mode: 0o600, flag: 'wx' });
      await fs.rename(temp, target);
    } catch (e) {
      await fs.rm(temp, { force: true });
      throw e;
    }
    return hash;
  }

  async get(hash: Sha256): Promise<Buffer> {
    let data: Buffer;
    try {
      data = await fs.readFile(this.pathFor(hash));
    } catch (e) {
      if (isNotFound(e)) {
        throw new SnapshotIntegrityError(hash);
      }
      throw e;
    }
    if (sha256(data) !== hash) {
      throw new SnapshotIntegrityError(hash);
    }
    return data;
  }

  async has(hash: Sha256): Promise<boolean> {
    return exists(this.pathFor(hash));
  }

  /** Deletes every blob not in keep. Returns the number of blobs removed. */
  async collectGarbage(keep: ReadonlySet<Sha256>): Promise<number> {
    let removed = 0;
    let shards: string[];
    try {
      shards = await fs.readdir(this.dir);
    } catch (e) {
      if (isNotFound(e)) {
        return 0;
      }
      throw e;
    }
    for (const shard of shards) {
      if (!/^[0-9a-f]{2}$/.test(shard)) {
        continue;
      }
      for (const name of await fs.readdir(path.join(this.dir, shard))) {
        if (!keep.has(shard + name)) {
          await fs.rm(path.join(this.dir, shard, name), { force: true });
          removed++;
        }
      }
    }
    return removed;
  }

  private pathFor(hash: Sha256): string {
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      throw new Error(`Invalid snapshot hash: ${hash}`);
    }
    return path.join(this.dir, hash.slice(0, 2), hash.slice(2));
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
