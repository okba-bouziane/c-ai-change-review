import * as fs from 'node:fs/promises';
import type { GlobSet } from '../core/glob';
import { inScope, normalizeRelPath, resolveInside, UnsafePathError } from '../core/paths';
import { mapLimit } from '../core/pool';
import {
  attribute,
  classify,
  pairRenames,
  restoreBlocker,
  withBlocker,
  type Baseline,
  type DetectedChange,
  type SessionData,
} from '../core/session';
import { walkFiles, type CaptureLimits } from './baseline';
import { FileStateCache, sha256 } from './fileState';
import type { Git, TreeEntry } from './git';

export interface DetectOptions {
  /** Root-relative paths reported by file watchers or hooks since the last run. */
  readonly hints?: Iterable<string>;
  /** Filesystem mode: rescan the whole tree instead of relying on hints. */
  readonly full?: boolean;
  readonly signal?: AbortSignal;
}

export interface DetectResult {
  readonly changes: DetectedChange[];
  /** True when lazily resolved baselines were added to the session and should be persisted. */
  readonly baselinesChanged: boolean;
}

const CONCURRENCY = 8;
/** Git baselines bigger than this are not read back for hashing. */
const MAX_GIT_BLOB_HASH_SIZE = 64 * 1024 * 1024;

/**
 * Computes the set of paths whose current state differs from the session baseline.
 *
 * Candidate paths come from Git (status now, plus everything committed since the
 * baseline if HEAD moved), every path with an explicit baseline, and watcher/hook hints.
 * Each candidate is then compared byte-for-byte (by SHA-256) with its baseline, so a file
 * that was edited and later edited back drops out of the list.
 */
export class ChangeTracker {
  private readonly cache = new FileStateCache();
  /** Paths reported as changed before; re-checked every run so they can drop out when reverted. */
  private readonly previouslyChanged = new Set<string>();

  constructor(
    private readonly session: SessionData,
    private readonly git: Git | undefined,
    private readonly exclude: GlobSet,
    private readonly limits: CaptureLimits,
  ) {}

  async detect(options: DetectOptions = {}): Promise<DetectResult> {
    const { signal } = options;
    const { session } = this;
    const candidates = new Set<string>([
      ...Object.keys(session.baselines),
      ...this.previouslyChanged,
    ]);

    if (this.git) {
      // Watcher hints are not candidates in Git mode: `git status` already reports every
      // non-ignored change, and ignored files are untracked unless explicitly captured.
      for (const entry of await this.git.status(session.scope, signal)) {
        candidates.add(entry.path);
      }
      const headNow = await this.git.head(signal);
      if (headNow !== session.head && headNow !== null) {
        // Commits made after the baseline hide changes from `git status`; include them.
        const moved =
          session.head === null
            ? await this.git.listTree(headNow, session.scope, signal)
            : await this.git.diffNames(session.head, headNow, session.scope, signal);
        moved.forEach((p) => candidates.add(p));
      }
    } else if (options.full) {
      const all = await walkFiles(session.root, this.exclude, this.limits.maxFiles, signal);
      all.forEach((p) => candidates.add(p));
    } else {
      for (const hint of options.hints ?? []) {
        let rel: string;
        try {
          rel = normalizeRelPath(hint);
        } catch (e) {
          if (e instanceof UnsafePathError) {
            continue;
          }
          throw e;
        }
        // File watchers may report only a new folder, not each file created inside it.
        const stat = await fs.lstat(resolveInside(session.root, rel)).catch(() => undefined);
        if (stat?.isDirectory()) {
          if (!this.exclude.matches(rel)) {
            const inside = await walkFiles(
              session.root,
              this.exclude,
              this.limits.maxFiles,
              signal,
              rel,
            );
            inside.forEach((p) => candidates.add(p));
          }
        } else {
          candidates.add(rel);
        }
      }
    }

    const paths = [...candidates].filter(
      (p) => inScope(session.scope, p) && !this.exclude.matches(p),
    );
    const { baselines, changed } = await this.resolveBaselines(paths, signal);

    const changes: DetectedChange[] = [];
    await mapLimit(
      paths,
      CONCURRENCY,
      async (p) => {
        const baseline = baselines.get(p);
        if (baseline === undefined) {
          return; // Ignored by Git and never captured: not tracked.
        }
        const abs = resolveInside(session.root, p);
        const current = await this.cache.read(abs, signal);
        if (
          current.type === 'other' &&
          current.reason === 'directory' &&
          baseline.type === 'absent'
        ) {
          return; // Folders are not reviewed; the files inside them are.
        }
        const kind = classify(baseline, current);
        if (kind) {
          changes.push(
            attribute(
              { path: p, kind, baseline, current, ...withBlocker(restoreBlocker(baseline)) },
              session.attribution[p],
            ),
          );
        }
      },
      signal,
    );

    this.previouslyChanged.clear();
    for (const c of changes) {
      this.previouslyChanged.add(c.path);
    }
    return { changes: pairRenames(changes), baselinesChanged: changed };
  }

  invalidate(abs: string): void {
    this.cache.invalidate(abs);
  }

  /**
   * Returns the baseline for each path. Paths without an explicit baseline are resolved
   * from the baseline commit (Git mode) or treated as new (filesystem mode). Paths that
   * Git ignores and that were never captured are left out entirely.
   */
  private async resolveBaselines(
    paths: readonly string[],
    signal?: AbortSignal,
  ): Promise<{ baselines: Map<string, Baseline>; changed: boolean }> {
    const { session, git } = this;
    const result = new Map<string, Baseline>();
    const unresolved: string[] = [];
    for (const p of paths) {
      const known = session.baselines[p];
      if (known) {
        result.set(p, known);
      } else {
        unresolved.push(p);
      }
    }
    if (unresolved.length === 0) {
      return { baselines: result, changed: false };
    }
    if (!git) {
      unresolved.forEach((p) => result.set(p, { type: 'absent' }));
      return { baselines: result, changed: false };
    }

    const inHead = session.head
      ? await git.lsTree(session.head, unresolved, signal)
      : new Map<string, TreeEntry>();
    const notInHead = unresolved.filter((p) => !inHead.has(p));
    const ignored = await git.checkIgnore(notInHead, signal);

    let changed = false;
    await mapLimit(
      unresolved,
      CONCURRENCY,
      async (p) => {
        const entry = inHead.get(p);
        let baseline: Baseline | undefined;
        if (entry) {
          baseline = await gitBaseline(git, p, entry, signal);
        } else if (!ignored.has(p)) {
          // Not in the baseline commit and not untracked at the baseline: it did not exist.
          baseline = { type: 'absent' };
        }
        if (baseline) {
          result.set(p, baseline);
          session.baselines[p] = baseline;
          changed = true;
        }
      },
      signal,
    );
    return { baselines: result, changed };
  }
}

async function gitBaseline(
  git: Git,
  relPath: string,
  entry: TreeEntry,
  signal?: AbortSignal,
): Promise<Baseline> {
  const { blob, mode, type } = entry;
  if (type !== 'blob') {
    return { type: 'unavailable', reason: `a Git ${type} (submodule), not a file` };
  }
  if (mode === 0o120000) {
    return { type: 'unavailable', reason: 'symbolic links are not restored' };
  }
  const size = entry.size ?? (await git.blobSize(blob, signal));
  if (size > MAX_GIT_BLOB_HASH_SIZE) {
    return { type: 'unavailable', reason: 'file is too large to compare' };
  }
  const data = await git.readBlobFiltered(blob, relPath, signal);
  return { type: 'git', blob, mode: mode & 0o777, hash: sha256(data), size: data.length };
}
