import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { SessionData } from '../core/session';
import { isNotFound } from '../services/fileState';

interface ActivePointer {
  readonly id: string;
}

/** Persists review sessions as JSON files with atomic writes. */
export class SessionStore {
  constructor(readonly dir: string) {}

  async save(session: SessionData): Promise<void> {
    await writeJsonAtomic(this.sessionPath(session.id), session);
  }

  async load(id: string): Promise<SessionData | undefined> {
    const data = await readJson(this.sessionPath(id));
    return isSessionData(data) ? data : undefined;
  }

  async setActive(id: string | undefined): Promise<void> {
    if (id === undefined) {
      await fs.rm(this.activePath(), { force: true });
    } else {
      await writeJsonAtomic(this.activePath(), { id } satisfies ActivePointer);
    }
  }

  async loadActive(): Promise<SessionData | undefined> {
    const pointer = await readJson(this.activePath());
    if (
      typeof pointer !== 'object' ||
      pointer === null ||
      typeof (pointer as ActivePointer).id !== 'string'
    ) {
      return undefined;
    }
    return this.load((pointer as ActivePointer).id);
  }

  private sessionPath(id: string): string {
    if (!/^[A-Za-z0-9-]+$/.test(id)) {
      throw new Error(`Invalid session id: ${id}`);
    }
    return path.join(this.dir, 'sessions', `${id}.json`);
  }

  private activePath(): string {
    return path.join(this.dir, 'active.json');
  }
}

function isSessionData(value: unknown): value is SessionData {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const v = value as Partial<SessionData>;
  return (
    v.version === 1 &&
    typeof v.id === 'string' &&
    typeof v.root === 'string' &&
    typeof v.scope === 'string' &&
    (v.mode === 'git' || v.mode === 'filesystem') &&
    typeof v.baselines === 'object' &&
    (v.baselines as unknown) !== null &&
    Array.isArray(v.log)
  );
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
  } catch (e) {
    if (isNotFound(e) || e instanceof SyntaxError) {
      return undefined;
    }
    throw e;
  }
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    await fs.rename(temp, file);
  } catch (e) {
    await fs.rm(temp, { force: true });
    throw e;
  }
}
