import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { GlobSet } from '../../../core/glob';
import type { DetectedChange, SessionData } from '../../../core/session';
import { captureBaseline, type CaptureLimits } from '../../../services/baseline';
import { ChangeTracker } from '../../../services/changeTracker';
import type { Git } from '../../../services/git';
import { plansForChange, restoreGroup, type RestoreResult } from '../../../services/restore';
import { SnapshotStore } from '../../../storage/snapshotStore';

const run = promisify(execFile);

export const DEFAULT_LIMITS: CaptureLimits = {
  maxFileSize: 5 * 1024 * 1024,
  maxTotalSize: 200 * 1024 * 1024,
  maxFiles: 20000,
};

const tempDirs: string[] = [];

/** A fresh directory under the OS temp folder. Never inside a real project. */
export async function tempDir(prefix = 'claude-review-'): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

export async function cleanupTempDirs(): Promise<void> {
  await Promise.all(tempDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
}

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, encoding: 'utf8' });
  return stdout;
}

export async function write(root: string, rel: string, content: string | Buffer): Promise<void> {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}

export async function read(root: string, rel: string): Promise<Buffer | undefined> {
  try {
    return await fs.readFile(path.join(root, rel));
  } catch {
    return undefined;
  }
}

export async function readText(root: string, rel: string): Promise<string | undefined> {
  return (await read(root, rel))?.toString('utf8');
}

/** Creates a repository with an initial commit containing files. */
export async function initRepo(files: Record<string, string | Buffer>): Promise<string> {
  const root = await tempDir('claude-review-repo-');
  await git(root, 'init', '-q', '-b', 'main');
  for (const [rel, content] of Object.entries(files)) {
    await write(root, rel, content);
  }
  if (Object.keys(files).length > 0) {
    await git(root, 'add', '-A');
    await git(root, 'commit', '-q', '-m', 'initial');
  }
  return root;
}

export interface HarnessOptions {
  readonly exclude?: string[];
  readonly sensitive?: string[];
  readonly limits?: Partial<CaptureLimits>;
  /** Workspace folder, if different from the repository root. */
  readonly folder?: string;
}

/** Drives the real capture → detect → restore pipeline against a temporary workspace. */
export class Harness {
  session!: SessionData;
  private tracker!: ChangeTracker;
  private gitApi: Git | undefined;
  readonly store: SnapshotStore;

  private constructor(
    readonly root: string,
    storageDir: string,
    private readonly options: HarnessOptions,
  ) {
    this.store = new SnapshotStore(path.join(storageDir, 'snapshots'));
  }

  static async start(root: string, options: HarnessOptions = {}): Promise<Harness> {
    const h = new Harness(root, await tempDir('claude-review-storage-'), options);
    await h.capture();
    return h;
  }

  get limits(): CaptureLimits {
    return { ...DEFAULT_LIMITS, ...this.options.limits };
  }

  async capture(): Promise<void> {
    const exclude = new GlobSet(this.options.exclude ?? ['**/node_modules/**']);
    const { session, git: g } = await captureBaseline(
      this.options.folder ?? this.root,
      this.store,
      {
        limits: this.limits,
        exclude,
        sensitive: new GlobSet(this.options.sensitive ?? ['.env', '*.pem']),
      },
    );
    this.session = session;
    this.gitApi = g;
    this.tracker = new ChangeTracker(session, g, exclude, this.limits);
  }

  async detect(hints: string[] = [], full = true): Promise<DetectedChange[]> {
    const { changes } = await this.tracker.detect({ hints, full });
    return changes.sort((a, b) => (a.path < b.path ? -1 : 1));
  }

  async change(relPath: string): Promise<DetectedChange> {
    const found = (await this.detect()).find((c) => c.path === relPath);
    if (!found) {
      throw new Error(`No change detected for ${relPath}`);
    }
    return found;
  }

  async reject(change: DetectedChange): Promise<RestoreResult[]> {
    return restoreGroup(plansForChange(change), {
      session: this.session,
      store: this.store,
      git: this.gitApi,
    });
  }

  /** Detects the change for relPath and rejects it. */
  async rejectPath(relPath: string): Promise<RestoreResult[]> {
    return this.reject(await this.change(relPath));
  }
}
