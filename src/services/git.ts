import { execFile, spawn } from 'node:child_process';
import * as path from 'node:path';

/**
 * The only Git subcommands this extension may run. None of them write to the index, the
 * working tree, refs, or the object database. Anything else is rejected before spawning,
 * so a bug can never turn into `git reset --hard` or `git clean`.
 */
const READ_ONLY_SUBCOMMANDS = new Set([
  'rev-parse',
  'status',
  'diff',
  'ls-files',
  'ls-tree',
  'cat-file',
  'check-ignore',
  'version',
]);

const MAX_BUFFER = 256 * 1024 * 1024;

export class GitError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

export interface StatusEntry {
  /** Root-relative path. */
  readonly path: string;
  readonly type: 'tracked' | 'unmerged' | 'untracked';
}

export interface TreeEntry {
  readonly mode: number;
  readonly type: string;
  readonly blob: string;
}

export interface GitOptions {
  readonly gitPath?: string;
  readonly signal?: AbortSignal;
}

export class Git {
  private readonly gitPath: string;

  constructor(
    /** Repository top-level directory. All commands run here. */
    readonly root: string,
    gitPath = 'git',
  ) {
    this.gitPath = gitPath;
  }

  /** Returns the top-level directory of the repository containing dir, or undefined. */
  static async findRoot(dir: string, gitPath = 'git'): Promise<string | undefined> {
    try {
      const out = await runGit(gitPath, dir, ['rev-parse', '--show-toplevel']);
      const top = out.toString('utf8').trim();
      return top === '' ? undefined : path.resolve(top);
    } catch {
      return undefined;
    }
  }

  /** HEAD commit id, or null when the current branch has no commits yet. */
  async head(signal?: AbortSignal): Promise<string | null> {
    try {
      const out = await this.run(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], signal);
      const id = out.toString('utf8').trim();
      return id === '' ? null : id;
    } catch (e) {
      if (e instanceof GitError && e.exitCode === 1) {
        return null;
      }
      throw e;
    }
  }

  /** Paths that differ between HEAD, the index, and the working tree, plus untracked files. */
  async status(scope: string, signal?: AbortSignal): Promise<StatusEntry[]> {
    const out = await this.run(
      [
        'status',
        '--porcelain=v2',
        '-z',
        '--untracked-files=all',
        '--no-renames',
        '--ignore-submodules=all',
        '--',
        pathspec(scope),
      ],
      signal,
    );
    return parseStatusV2(out.toString('utf8'));
  }

  /** Root-relative paths that differ between two commits. */
  async diffNames(
    from: string,
    to: string,
    scope: string,
    signal?: AbortSignal,
  ): Promise<string[]> {
    const out = await this.run(
      [
        'diff',
        '--name-only',
        '-z',
        '--no-renames',
        '--ignore-submodules=all',
        from,
        to,
        '--',
        pathspec(scope),
      ],
      signal,
    );
    return splitZ(out.toString('utf8'));
  }

  /** Every file path in a commit's tree under scope. */
  async listTree(commit: string, scope: string, signal?: AbortSignal): Promise<string[]> {
    const out = await this.run(
      ['ls-tree', '-r', '-z', '--name-only', '--full-tree', commit, '--', pathspec(scope)],
      signal,
    );
    return splitZ(out.toString('utf8'));
  }

  /** Looks up specific paths in a commit. Paths absent from the commit are omitted. */
  async lsTree(
    commit: string,
    paths: readonly string[],
    signal?: AbortSignal,
  ): Promise<Map<string, TreeEntry>> {
    const result = new Map<string, TreeEntry>();
    for (const chunk of chunks(paths, 500)) {
      const out = await this.run(['ls-tree', '-z', '--full-tree', commit, '--', ...chunk], signal);
      for (const record of splitZ(out.toString('utf8'))) {
        // "<mode> SP <type> SP <object> TAB <path>"
        const tab = record.indexOf('\t');
        const [mode, type, blob] = record.slice(0, tab).split(' ');
        if (mode && type && blob) {
          result.set(record.slice(tab + 1), { mode: parseInt(mode, 8), type, blob });
        }
      }
    }
    return result;
  }

  /** The subset of paths that Git ignores. */
  async checkIgnore(paths: readonly string[], signal?: AbortSignal): Promise<Set<string>> {
    if (paths.length === 0) {
      return new Set();
    }
    try {
      const out = await this.run(
        ['check-ignore', '--no-index', '-z', '--stdin'],
        signal,
        Buffer.from(paths.map((p) => `${p}\0`).join(''), 'utf8'),
      );
      return new Set(splitZ(out.toString('utf8')));
    } catch (e) {
      // Exit code 1 means "none of the paths are ignored".
      if (e instanceof GitError && e.exitCode === 1) {
        return new Set();
      }
      throw e;
    }
  }

  /** Object size in bytes before filters. */
  async blobSize(blob: string, signal?: AbortSignal): Promise<number> {
    const out = await this.run(['cat-file', '-s', blob], signal);
    return Number(out.toString('utf8').trim());
  }

  /**
   * A blob's content exactly as `git checkout` would write it for path, applying
   * end-of-line conversion and smudge filters configured for that path.
   */
  async readBlobFiltered(blob: string, relPath: string, signal?: AbortSignal): Promise<Buffer> {
    return this.run(['cat-file', '--filters', `--path=${relPath}`, blob], signal);
  }

  private run(args: readonly string[], signal?: AbortSignal, input?: Buffer): Promise<Buffer> {
    return runGit(this.gitPath, this.root, args, signal, input);
  }
}

export function assertReadOnly(args: readonly string[]): void {
  const sub = args[0];
  if (sub === undefined || !READ_ONLY_SUBCOMMANDS.has(sub)) {
    throw new Error(`Refusing to run non-read-only git command: git ${args.join(' ')}`);
  }
}

function runGit(
  gitPath: string,
  cwd: string,
  args: readonly string[],
  signal?: AbortSignal,
  input?: Buffer,
): Promise<Buffer> {
  assertReadOnly(args);
  // --literal-pathspecs: file names are never interpreted as globs or magic pathspecs.
  // check-ignore takes plain path names, not pathspecs, and rejects the flag.
  const literal = args[0] === 'check-ignore' ? [] : ['--literal-pathspecs'];
  const fullArgs = [...literal, '-c', 'core.quotepath=off', ...args];
  return new Promise((resolve, reject) => {
    if (input === undefined) {
      execFile(
        gitPath,
        fullArgs,
        {
          cwd,
          env: gitEnv(),
          encoding: 'buffer',
          maxBuffer: MAX_BUFFER,
          signal,
          windowsHide: true,
        },
        (err, stdout, stderr) => {
          if (err) {
            reject(toGitError(err, args, stderr));
          } else {
            resolve(stdout);
          }
        },
      );
      return;
    }

    const child = spawn(gitPath, fullArgs, { cwd, env: gitEnv(), signal, windowsHide: true });
    const out: Buffer[] = [];
    const errOut: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => errOut.push(d));
    child.on('error', (e) => {
      reject(toGitError(e, args, Buffer.concat(errOut)));
    });
    child.on('close', (code) => {
      const stderr = Buffer.concat(errOut);
      if (code === 0) {
        resolve(Buffer.concat(out));
      } else {
        reject(
          new GitError(
            `git ${args[0] ?? ''} exited with ${code ?? 'signal'}`,
            code,
            stderr.toString('utf8'),
          ),
        );
      }
    });
    child.stdin.end(input);
  });
}

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // Read-only commands like `git status` must never take index.lock or refresh the index,
    // so they cannot collide with Claude or the user running Git at the same time.
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
  };
}

function toGitError(err: Error, args: readonly string[], stderr: Buffer | string): Error {
  if (err.name === 'AbortError') {
    return err;
  }
  const code = (err as { code?: unknown }).code;
  return new GitError(
    `git ${args[0] ?? ''} failed: ${err.message}`,
    typeof code === 'number' ? code : null,
    stderr.toString(),
  );
}

export function parseStatusV2(output: string): StatusEntry[] {
  const entries: StatusEntry[] = [];
  const records = output.split('\0');
  for (let i = 0; i < records.length; i++) {
    const record = records[i] ?? '';
    switch (record[0]) {
      case '1':
        entries.push({ path: fieldsAfter(record, 8), type: 'tracked' });
        break;
      case '2':
        // Only produced when renames are enabled; the original path follows as its own record.
        entries.push({ path: fieldsAfter(record, 9), type: 'tracked' });
        i++;
        break;
      case 'u':
        entries.push({ path: fieldsAfter(record, 10), type: 'unmerged' });
        break;
      case '?':
        entries.push({ path: record.slice(2), type: 'untracked' });
        break;
      default:
        break;
    }
  }
  return entries;
}

/** The remainder of a space-separated record after skipping n fields (paths may contain spaces). */
function fieldsAfter(record: string, n: number): string {
  let index = 0;
  for (let i = 0; i < n; i++) {
    index = record.indexOf(' ', index) + 1;
  }
  return record.slice(index);
}

function splitZ(output: string): string[] {
  return output.split('\0').filter((s) => s !== '');
}

function pathspec(scope: string): string {
  return scope === '' ? '.' : scope;
}

function* chunks<T>(items: readonly T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) {
    yield items.slice(i, i + size);
  }
}
