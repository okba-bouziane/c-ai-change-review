/*
 * Claude Review hook for Claude Code (bundled to dist/hook.js).
 *
 * Registered for PreToolUse/PostToolUse on Write|Edit|MultiEdit|NotebookEdit, and for
 * UserPromptSubmit and Stop. It records what Claude is about to change and what it changed,
 * then exits. Guarantees:
 *   - always exits 0 and prints nothing, so it can never block a tool, alter a prompt, or
 *     add text to Claude's context;
 *   - never writes inside the workspace; only into the extension's storage directory;
 *   - never stores the prompt text;
 *   - ignores paths outside the workspace, excluded paths, and does not copy sensitive files.
 *
 * Synchronous I/O is intentional: this is a short-lived process, not the extension host.
 */
/* eslint-disable no-restricted-syntax */
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { GlobSet } from '../core/glob';
import { isInside, toPosix } from '../core/paths';
import {
  EVENTS_DIR,
  FILE_TOOLS,
  HOOK_CONFIG_FILE,
  HOOK_PROTOCOL_VERSION,
  SNAPSHOTS_DIR,
  type HookConfig,
  type HookEvent,
  type HookFileState,
} from './protocol';

interface HookInput {
  readonly hook_event_name?: unknown;
  readonly session_id?: unknown;
  readonly cwd?: unknown;
  readonly tool_name?: unknown;
  readonly tool_input?: unknown;
}

function main(argv: readonly string[]): void {
  const storage = argValue(argv, '--storage');
  if (!storage) {
    return;
  }
  const config = readConfig(storage);
  if (!config) {
    return; // Extension never configured this workspace (or config is unreadable): do nothing.
  }
  const input = JSON.parse(fs.readFileSync(0, 'utf8')) as HookInput;
  const event = typeof input.hook_event_name === 'string' ? input.hook_event_name : '';
  const claudeSessionId = typeof input.session_id === 'string' ? input.session_id : undefined;
  const base = {
    v: HOOK_PROTOCOL_VERSION,
    at: Date.now(),
    ...(claudeSessionId ? { claudeSessionId } : {}),
  };

  if (event === 'UserPromptSubmit') {
    writeEvent(storage, { ...base, type: 'prompt' });
    return;
  }
  if (event === 'Stop') {
    writeEvent(storage, { ...base, type: 'stop' });
    return;
  }
  if (event !== 'PreToolUse' && event !== 'PostToolUse') {
    return;
  }

  const tool = typeof input.tool_name === 'string' ? input.tool_name : '';
  const field = FILE_TOOLS[tool];
  const toolInput = input.tool_input as Record<string, unknown> | undefined;
  const rawPath = field ? toolInput?.[field] : undefined;
  if (typeof rawPath !== 'string' || rawPath === '') {
    return;
  }
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
  const abs = path.resolve(cwd, rawPath);
  if (!isInside(config.root, abs)) {
    return;
  }
  const rel = toPosix(path.relative(config.root, abs));
  if (rel === '' || rel.split('/').includes('.git') || new GlobSet(config.exclude).matches(rel)) {
    return;
  }

  const copy = event === 'PreToolUse' && !new GlobSet(config.sensitive).matches(rel);
  const state = readState(abs, storage, copy, config.maxFileSize);
  writeEvent(storage, {
    ...base,
    type: event === 'PreToolUse' ? 'pre' : 'post',
    tool,
    path: abs,
    state,
  });
}

function readState(
  abs: string,
  storage: string,
  copy: boolean,
  maxFileSize: number,
): HookFileState {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(abs);
  } catch {
    return { type: 'absent' };
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    return {
      type: 'other',
      reason: stat.isSymbolicLink() ? 'symbolic link' : 'not a regular file',
    };
  }
  const mode = stat.mode & 0o777;
  if (stat.size > maxFileSize) {
    const hash = hashInChunks(abs);
    return {
      type: 'file',
      hash,
      size: stat.size,
      mode,
      stored: false,
      reason: 'larger than the snapshot size limit',
    };
  }
  const data = fs.readFileSync(abs);
  const hash = createHash('sha256').update(data).digest('hex');
  if (!copy) {
    return { type: 'file', hash, size: data.length, mode, stored: false, reason: 'not copied' };
  }
  storeBlob(storage, hash, data);
  return { type: 'file', hash, size: data.length, mode, stored: true };
}

function hashInChunks(abs: string): string {
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(1024 * 1024);
  const fd = fs.openSync(abs, 'r');
  try {
    for (let n = fs.readSync(fd, buffer); n > 0; n = fs.readSync(fd, buffer)) {
      hash.update(buffer.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function storeBlob(storage: string, hash: string, data: Buffer): void {
  const target = path.join(storage, SNAPSHOTS_DIR, hash.slice(0, 2), hash.slice(2));
  if (fs.existsSync(target)) {
    // Refresh mtime so retention's grace period protects it until the event is ingested.
    const now = new Date();
    fs.utimesSync(target, now, now);
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temp, data, { mode: 0o600, flag: 'wx' });
  fs.renameSync(temp, target);
}

function writeEvent(storage: string, event: HookEvent): void {
  const dir = path.join(storage, EVENTS_DIR);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = `${String(event.at).padStart(15, '0')}-${String(process.pid)}-${randomBytes(4).toString('hex')}`;
  const temp = path.join(dir, `${name}.tmp`);
  fs.writeFileSync(temp, JSON.stringify(event), { mode: 0o600, flag: 'wx' });
  fs.renameSync(temp, path.join(dir, `${name}.json`));
}

function readConfig(storage: string): HookConfig | undefined {
  try {
    const config = JSON.parse(
      fs.readFileSync(path.join(storage, HOOK_CONFIG_FILE), 'utf8'),
    ) as HookConfig;
    return config.version === HOOK_PROTOCOL_VERSION && typeof config.root === 'string'
      ? config
      : undefined;
  } catch {
    return undefined;
  }
}

function argValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

try {
  main(process.argv.slice(2));
} catch {
  // Never disturb Claude Code: any failure means "record nothing".
}
process.exitCode = 0;
