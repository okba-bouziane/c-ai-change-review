import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isNotFound } from '../services/fileState';

/** Every command this extension installs contains this marker; nothing else is ever touched. */
export const HOOK_MARKER = 'claude-review-hook';

const FILE_TOOL_MATCHER = 'Write|Edit|MultiEdit|NotebookEdit';
const HOOK_TIMEOUT_SECONDS = 10;

/** The hook events this extension uses, and why. */
export const HOOK_EVENTS: readonly { event: string; matcher?: string; purpose: string }[] = [
  {
    event: 'PreToolUse',
    matcher: FILE_TOOL_MATCHER,
    purpose: 'copies a file just before Claude edits it, so the exact original can be restored',
  },
  {
    event: 'PostToolUse',
    matcher: FILE_TOOL_MATCHER,
    purpose: 'records what Claude wrote, so its edits can be told apart from other changes',
  },
  {
    event: 'UserPromptSubmit',
    purpose: 'marks the start of a new task (the prompt text is not stored)',
  },
  { event: 'Stop', purpose: 'notices when Claude has finished, to offer the review' },
];

export class SettingsParseError extends Error {
  constructor(
    readonly file: string,
    detail: string,
  ) {
    super(`${file} is not valid JSON (${detail}). It was not modified.`);
    this.name = 'SettingsParseError';
  }
}

export type JsonObject = Record<string, unknown>;

export interface SettingsSnapshot {
  readonly file: string;
  readonly exists: boolean;
  /** Exact original text, for backups and previews. */
  readonly text: string;
  readonly value: JsonObject;
}

export async function readSettings(file: string): Promise<SettingsSnapshot> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (e) {
    if (isNotFound(e)) {
      return { file, exists: false, text: '', value: {} };
    }
    throw e;
  }
  if (text.trim() === '') {
    return { file, exists: true, text, value: {} };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    throw new SettingsParseError(file, e instanceof Error ? e.message : String(e));
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SettingsParseError(file, 'the top level is not an object');
  }
  const hooks = (value as JsonObject).hooks;
  if (
    hooks !== undefined &&
    (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks))
  ) {
    throw new SettingsParseError(file, '"hooks" is not an object');
  }
  return { file, exists: true, text, value: value as JsonObject };
}

/**
 * Returns settings with this extension's hooks added (replacing any previous version of
 * them). Every other key, event, matcher group, and hook is kept exactly, in order.
 */
export function withOurHooks(settings: JsonObject, command: string): JsonObject {
  const cleaned = withoutOurHooks(settings);
  const hooks = { ...((cleaned.hooks as JsonObject | undefined) ?? {}) };
  for (const { event, matcher } of HOOK_EVENTS) {
    const groups = Array.isArray(hooks[event]) ? [...(hooks[event] as unknown[])] : [];
    groups.push({
      ...(matcher !== undefined ? { matcher } : {}),
      hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_SECONDS }],
    });
    hooks[event] = groups;
  }
  return { ...cleaned, hooks };
}

/**
 * Returns settings with every hook whose command contains HOOK_MARKER removed. Matcher
 * groups and event arrays left empty by that removal are dropped, and so is the `hooks`
 * key if nothing else remains in it. Nothing else changes.
 */
export function withoutOurHooks(settings: JsonObject): JsonObject {
  const hooks = settings.hooks;
  if (typeof hooks !== 'object' || hooks === null) {
    return settings;
  }
  const nextHooks: JsonObject = {};
  for (const [event, groups] of Object.entries(hooks as JsonObject)) {
    if (!Array.isArray(groups)) {
      nextHooks[event] = groups;
      continue;
    }
    const keptGroups: unknown[] = [];
    for (const group of groups) {
      const handlers = (group as { hooks?: unknown } | null)?.hooks;
      if (!Array.isArray(handlers)) {
        keptGroups.push(group);
        continue;
      }
      const keptHandlers = handlers.filter((h) => !isOurHandler(h));
      if (keptHandlers.length === handlers.length) {
        keptGroups.push(group);
      } else if (keptHandlers.length > 0) {
        keptGroups.push({ ...(group as JsonObject), hooks: keptHandlers });
      }
    }
    // An event left with no groups is dropped; an empty event array has no effect anyway.
    if (keptGroups.length > 0) {
      nextHooks[event] = keptGroups;
    }
  }
  const result: JsonObject = { ...settings };
  if (Object.keys(nextHooks).length > 0) {
    result.hooks = nextHooks;
  } else {
    delete result.hooks;
  }
  return result;
}

export function hasOurHooks(settings: JsonObject): boolean {
  const hooks = settings.hooks;
  if (typeof hooks !== 'object' || hooks === null) {
    return false;
  }
  return Object.values(hooks as JsonObject).some(
    (groups) =>
      Array.isArray(groups) &&
      groups.some((g) => {
        const handlers = (g as { hooks?: unknown } | null)?.hooks;
        return Array.isArray(handlers) && handlers.some(isOurHandler);
      }),
  );
}

function isOurHandler(handler: unknown): boolean {
  const command = (handler as { command?: unknown } | null)?.command;
  return typeof command === 'string' && command.includes(HOOK_MARKER);
}

export function formatSettings(value: JsonObject): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Verifies that `written` equals `original` except for this extension's hooks: every
 * other setting and every foreign hook survived. Throws if anything else differs.
 */
export function assertOnlyOurHooksChanged(original: JsonObject, written: JsonObject): void {
  const a = JSON.stringify(canonical(withoutOurHooks(original)));
  const b = JSON.stringify(canonical(withoutOurHooks(written)));
  if (a !== b) {
    throw new Error('Verification failed: settings other than Claude Review hooks would change.');
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value as JsonObject)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonical(v)]),
    );
  }
  return value;
}

/**
 * Writes new settings only if the file still has the exact text it had when read, with a
 * backup of the original and an atomic rename. Re-reads and verifies the result.
 */
export async function writeSettings(
  snapshot: SettingsSnapshot,
  next: JsonObject,
  backupDir: string,
): Promise<{ backup: string | undefined }> {
  assertOnlyOurHooksChanged(snapshot.value, next);
  const current = await readSettings(snapshot.file);
  if (current.exists !== snapshot.exists || current.text !== snapshot.text) {
    throw new Error(
      `${snapshot.file} changed while the preview was open. Nothing was written; try again.`,
    );
  }

  let backup: string | undefined;
  if (snapshot.exists) {
    await fs.mkdir(backupDir, { recursive: true, mode: 0o700 });
    backup = path.join(
      backupDir,
      `${path.basename(snapshot.file)}.${new Date().toISOString().replace(/[:.]/g, '-')}.bak`,
    );
    await fs.writeFile(backup, snapshot.text, { mode: 0o600, flag: 'wx' });
  }

  await fs.mkdir(path.dirname(snapshot.file), { recursive: true });
  const temp = `${snapshot.file}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await fs.writeFile(temp, formatSettings(next), { flag: 'wx', mode: 0o644 });
    await fs.rename(temp, snapshot.file);
  } finally {
    await fs.rm(temp, { force: true });
  }

  const written = await readSettings(snapshot.file);
  assertOnlyOurHooksChanged(snapshot.value, written.value);
  return { backup };
}

/** Quotes a value for a POSIX shell command line (Claude Code runs hooks through a shell). */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface HookRuntime {
  /** Absolute path of a Node.js binary, or of VS Code's Electron binary. */
  readonly executable: string;
  /** True when executable is Electron and must run with ELECTRON_RUN_AS_NODE=1. */
  readonly electron: boolean;
}

export function buildHookCommand(
  runtime: HookRuntime,
  scriptPath: string,
  storageDir: string,
): string {
  const prefix = runtime.electron ? 'ELECTRON_RUN_AS_NODE=1 ' : '';
  // scriptPath contains HOOK_MARKER, which is how our entries are recognized later.
  return `${prefix}${shellQuote(runtime.executable)} ${shellQuote(scriptPath)} --storage ${shellQuote(storageDir)}`;
}
