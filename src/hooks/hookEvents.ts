import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { inScope, relativeTo } from '../core/paths';
import type { Attribution, Baseline, SessionData } from '../core/session';
import { isNotFound } from '../services/fileState';
import {
  EVENTS_DIR,
  isHookEvent,
  type EditEvent,
  type HookEvent,
  type HookFileState,
} from './protocol';

export interface PendingEvent {
  readonly file: string;
  readonly event: HookEvent;
}

/** Reads queued hook events in the order they were written. Malformed files are deleted. */
export async function readPendingEvents(storageDir: string): Promise<PendingEvent[]> {
  const dir = path.join(storageDir, EVENTS_DIR);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (e) {
    if (isNotFound(e)) {
      return [];
    }
    throw e;
  }
  const result: PendingEvent[] = [];
  for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
    const file = path.join(dir, name);
    try {
      const value = JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
      if (isHookEvent(value)) {
        result.push({ file, event: value });
        continue;
      }
    } catch (e) {
      if (isNotFound(e)) {
        continue;
      }
    }
    await fs.rm(file, { force: true });
  }
  return result;
}

export async function deleteEvent(pending: PendingEvent): Promise<void> {
  await fs.rm(pending.file, { force: true });
}

export interface ApplyContext {
  /** True when Git ignores the root-relative path (always false outside Git). */
  readonly isIgnored: (key: string) => Promise<boolean>;
}

/** Result of applying a file event, or undefined when it did not concern this session. */
export interface AppliedEdit {
  readonly key: string;
}

/**
 * Records a pre/post edit event in the session's attribution map.
 *
 * Pre-edit: the first one for a path keeps the file as it was right before Claude's first
 * edit. If the session has no baseline for the path yet and Git ignores it (so it would
 * otherwise be untracked), that pre-edit snapshot becomes its baseline. If the edit
 * happened before the session's baseline was captured (a race at session start), the
 * pre-edit snapshot also replaces the baseline, so Claude's edit is not hidden inside it.
 *
 * Post-edit: remembers what Claude wrote, to tell later outside edits apart.
 */
export async function applyEditEvent(
  session: SessionData,
  event: EditEvent,
  context: ApplyContext,
): Promise<AppliedEdit | undefined> {
  const key = relativeTo(session.root, event.path);
  if (key === undefined || !inScope(session.scope, key) || key.split('/').includes('.git')) {
    return undefined;
  }
  const existing = session.attribution[key];
  const at = new Date(event.at).toISOString();
  const claude = event.claudeSessionId ? { claudeSessionId: event.claudeSessionId } : {};

  if (event.type === 'pre') {
    if (existing) {
      return { key };
    }
    const before = toBaseline(event.state);
    session.attribution[key] = { before, at, ...claude };
    const startedAt = Date.parse(session.createdAt);
    if (event.at < startedAt && before.type !== 'unavailable') {
      session.baselines[key] = before;
    } else if (session.baselines[key] === undefined && (await context.isIgnored(key))) {
      session.baselines[key] = before;
    }
    return { key };
  }

  const afterToken = toToken(event.state);
  const updated: Attribution = existing
    ? { ...existing, ...(afterToken !== undefined ? { afterToken } : {}) }
    : {
        // The pre-edit event was missed (hooks installed mid-task): attribution only.
        before: {
          type: 'unavailable',
          reason: 'the file was not captured before Claude edited it',
        },
        at,
        ...claude,
        ...(afterToken !== undefined ? { afterToken } : {}),
      };
  session.attribution[key] = updated;
  return { key };
}

function toBaseline(state: HookFileState): Baseline {
  switch (state.type) {
    case 'absent':
      return { type: 'absent' };
    case 'file':
      return state.stored
        ? { type: 'stored', hash: state.hash, size: state.size, mode: state.mode }
        : {
            type: 'unavailable',
            reason: state.reason ?? 'not copied',
            hash: state.hash,
            size: state.size,
          };
    case 'other':
      return { type: 'unavailable', reason: state.reason };
  }
}

function toToken(state: HookFileState): string | undefined {
  switch (state.type) {
    case 'absent':
      return 'absent';
    case 'file':
      return `file:${state.hash}:${state.mode.toString(8)}`;
    case 'other':
      return undefined;
  }
}
