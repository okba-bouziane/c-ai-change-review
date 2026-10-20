import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as esbuild from 'esbuild';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { GlobSet } from '../../core/glob';
import { applyEditEvent, deleteEvent, readPendingEvents } from '../../hooks/hookEvents';
import { EVENTS_DIR, HOOK_CONFIG_FILE, isEditEvent, type HookConfig } from '../../hooks/protocol';
import {
  assertOnlyOurHooksChanged,
  buildHookCommand,
  formatSettings,
  hasOurHooks,
  HOOK_MARKER,
  readSettings,
  SettingsParseError,
  withOurHooks,
  withoutOurHooks,
  writeSettings,
  type JsonObject,
} from '../../hooks/settingsFile';
import { rejectMany } from '../../services/actions';
import { Git } from '../../services/git';
import {
  cleanupTempDirs,
  git,
  Harness,
  initRepo,
  readText,
  tempDir,
  write,
} from './helpers/workspace';

let hookScript: string;

beforeAll(async () => {
  const outDir = await fs.mkdtemp(
    path.join((await import('node:os')).tmpdir(), 'claude-review-hookbuild-'),
  );
  // The file name must contain the marker, exactly like the installed copy.
  hookScript = path.join(outDir, `${HOOK_MARKER}.js`);
  await esbuild.build({
    entryPoints: ['src/hooks/hookScript.ts'],
    outfile: hookScript,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    logLevel: 'silent',
  });
});

afterEach(cleanupTempDirs);

interface RunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function run(command: string, args: string[], stdin: string, shell = false): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(stdin);
  });
}

function runHook(storage: string, input: unknown): Promise<RunResult> {
  const stdin = typeof input === 'string' ? input : JSON.stringify(input);
  return run(process.execPath, [hookScript, '--storage', storage], stdin);
}

async function configure(
  storage: string,
  root: string,
  extra: Partial<HookConfig> = {},
): Promise<void> {
  await fs.mkdir(storage, { recursive: true });
  const config: HookConfig = {
    version: 1,
    root,
    exclude: ['**/node_modules/**'],
    sensitive: ['.env', '*.pem'],
    maxFileSize: 5 * 1024 * 1024,
    ...extra,
  };
  await fs.writeFile(path.join(storage, HOOK_CONFIG_FILE), JSON.stringify(config));
}

const toolEvent = (event: string, root: string, file: string, tool = 'Edit'): JsonObject => ({
  session_id: 'claude-session-1',
  transcript_path: '/tmp/t.jsonl',
  cwd: root,
  hook_event_name: event,
  tool_name: tool,
  tool_input:
    tool === 'NotebookEdit'
      ? { notebook_path: file, new_source: 'x' }
      : { file_path: file, old_string: 'a', new_string: 'b' },
  tool_use_id: 'toolu_1',
});

async function eventFiles(storage: string): Promise<string[]> {
  return (await fs.readdir(path.join(storage, EVENTS_DIR)).catch(() => [])).filter((n) =>
    n.endsWith('.json'),
  );
}

/** Mirrors ReviewController.ingestHookEvents for the session in a test harness. */
async function ingest(h: Harness, storage: string): Promise<void> {
  const gitApi = h.session.mode === 'git' ? new Git(h.session.root) : undefined;
  for (const item of await readPendingEvents(storage)) {
    if (isEditEvent(item.event)) {
      await applyEditEvent(h.session, item.event, {
        isIgnored: async (key) => (gitApi ? (await gitApi.checkIgnore([key])).has(key) : false),
      });
    }
    await deleteEvent(item);
  }
}

describe('hook script', () => {
  it('records a pre-edit copy and a post-edit hash, silently, with exit code 0', async () => {
    const root = await tempDir();
    const storage = await tempDir();
    await configure(storage, root);
    await write(root, 'src/a.ts', 'before\n');

    const pre = await runHook(storage, toolEvent('PreToolUse', root, path.join(root, 'src/a.ts')));
    await write(root, 'src/a.ts', 'after\n');
    const post = await runHook(storage, toolEvent('PostToolUse', root, 'src/a.ts')); // relative to cwd
    for (const r of [pre, post]) {
      expect(r).toEqual({ code: 0, stdout: '', stderr: '' });
    }

    const events = await readPendingEvents(storage);
    expect(events.map((e) => e.event.type)).toEqual(['pre', 'post']);
    const [first] = events;
    expect(first?.event).toMatchObject({
      tool: 'Edit',
      path: path.join(root, 'src/a.ts'),
      claudeSessionId: 'claude-session-1',
      state: { type: 'file', size: 7, stored: true },
    });
    const state = first && isEditEvent(first.event) ? first.event.state : undefined;
    if (state?.type !== 'file') {
      throw new Error('expected a file state');
    }
    const blob = path.join(storage, 'snapshots', state.hash.slice(0, 2), state.hash.slice(2));
    expect(await fs.readFile(blob, 'utf8')).toBe('before\n');
    expect((await fs.stat(blob)).mode & 0o077).toBe(0);
  });

  it('records a new file as absent before Write and handles NotebookEdit paths', async () => {
    const root = await tempDir();
    const storage = await tempDir();
    await configure(storage, root);
    await runHook(storage, toolEvent('PreToolUse', root, path.join(root, 'new.ts'), 'Write'));
    await runHook(
      storage,
      toolEvent('PreToolUse', root, path.join(root, 'nb.ipynb'), 'NotebookEdit'),
    );
    const events = await readPendingEvents(storage);
    expect(
      events.map((e) => (isEditEvent(e.event) ? `${e.event.tool}:${e.event.state.type}` : '')),
    ).toEqual(['Write:absent', 'NotebookEdit:absent']);
  });

  it('never stores prompt text', async () => {
    const root = await tempDir();
    const storage = await tempDir();
    await configure(storage, root);
    const result = await runHook(storage, {
      session_id: 's',
      cwd: root,
      hook_event_name: 'UserPromptSubmit',
      prompt: 'TOP SECRET PROMPT TEXT',
    });
    expect(result).toEqual({ code: 0, stdout: '', stderr: '' });
    const [file] = await eventFiles(storage);
    const text = await fs.readFile(path.join(storage, EVENTS_DIR, file ?? ''), 'utf8');
    expect(text).not.toContain('SECRET');
    expect(JSON.parse(text)).toMatchObject({ type: 'prompt', claudeSessionId: 's' });
  });

  it('ignores paths outside the workspace, in .git, excluded, and other tools', async () => {
    const root = await tempDir();
    const outside = await tempDir();
    const storage = await tempDir();
    await configure(storage, root);
    await write(outside, 'x.ts', 'x');
    await runHook(storage, toolEvent('PreToolUse', root, path.join(outside, 'x.ts')));
    await runHook(storage, toolEvent('PreToolUse', root, '../escape.ts'));
    await runHook(storage, toolEvent('PreToolUse', root, path.join(root, '.git/config')));
    await runHook(storage, toolEvent('PreToolUse', root, path.join(root, 'node_modules/p/i.js')));
    await runHook(storage, {
      ...toolEvent('PreToolUse', root, 'a.ts'),
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });
    await runHook(storage, { ...toolEvent('PreToolUse', root, 'a.ts'), tool_name: 'Read' });
    expect(await eventFiles(storage)).toEqual([]);
  });

  it('does not copy sensitive or oversized files but still hashes them', async () => {
    const root = await tempDir();
    const storage = await tempDir();
    await configure(storage, root, { maxFileSize: 10 });
    await write(root, '.env', 'KEY=1\n');
    await write(root, 'big.txt', 'more than ten bytes\n');
    await runHook(storage, toolEvent('PreToolUse', root, path.join(root, '.env')));
    await runHook(storage, toolEvent('PreToolUse', root, path.join(root, 'big.txt')));
    const states = (await readPendingEvents(storage)).map((e) =>
      isEditEvent(e.event) ? e.event.state : undefined,
    );
    expect(states.map((s) => s?.type === 'file' && s.stored)).toEqual([false, false]);
    expect(states.every((s) => s?.type === 'file' && /^[0-9a-f]{64}$/.test(s.hash))).toBe(true);
    await expect(fs.readdir(path.join(storage, 'snapshots'))).rejects.toThrow();
  });

  it('exits 0 with no output on garbage input, missing config, or missing arguments', async () => {
    const root = await tempDir();
    const storage = await tempDir();
    expect(await runHook(storage, toolEvent('PreToolUse', root, 'a.ts'))).toEqual({
      code: 0,
      stdout: '',
      stderr: '',
    });
    await configure(storage, root);
    for (const input of ['', 'not json', '[]', '{"hook_event_name": 42}', '{"tool_input": null}']) {
      expect(await runHook(storage, input)).toEqual({ code: 0, stdout: '', stderr: '' });
    }
    expect(await run(process.execPath, [hookScript], '{}')).toEqual({
      code: 0,
      stdout: '',
      stderr: '',
    });
    expect(await eventFiles(storage)).toEqual([]);
  });

  it('runs through a shell command line with spaces and quotes in every path', async () => {
    const root = await tempDir("claude review 'root' ");
    const storage = path.join(await tempDir(), "Application Support/it's here");
    await configure(storage, root);
    const scriptDir = path.join(await tempDir(), 'with space');
    await fs.mkdir(scriptDir);
    const script = path.join(scriptDir, `${HOOK_MARKER}.js`);
    await fs.copyFile(hookScript, script);
    await write(root, 'a.ts', 'a');

    const command = buildHookCommand(
      { executable: process.execPath, electron: false },
      script,
      storage,
    );
    expect(command).toContain(HOOK_MARKER);
    const result = await run(
      '/bin/sh',
      ['-c', command],
      JSON.stringify(toolEvent('PreToolUse', root, path.join(root, 'a.ts'))),
    );
    expect(result).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(await eventFiles(storage)).toHaveLength(1);
  });
});

describe('17. Claude Code settings are preserved', () => {
  const userSettings: JsonObject = {
    model: 'opus',
    permissions: { allow: ['Bash(npm test)'], deny: ['Read(./.env)'] },
    env: { FOO: 'bar' },
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [{ type: 'command', command: '/usr/local/bin/my-guard.sh', timeout: 5 }],
        },
      ],
      Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }],
      SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'echo hi' }] }],
    },
    statusLine: { type: 'command', command: 'echo status' },
  };
  const command = `'/usr/bin/node' '/x/${HOOK_MARKER}.js' --storage '/s'`;

  it('adds our hooks after existing ones and keeps everything else', () => {
    const next = withOurHooks(userSettings, command);
    assertOnlyOurHooksChanged(userSettings, next);
    expect(hasOurHooks(next)).toBe(true);
    const hooks = next.hooks as Record<
      string,
      { matcher?: string; hooks: { command: string }[] }[]
    >;
    expect(hooks.PreToolUse?.map((g) => g.matcher)).toEqual([
      'Bash',
      'Write|Edit|MultiEdit|NotebookEdit',
    ]);
    expect(hooks.PreToolUse?.[0]?.hooks[0]?.command).toBe('/usr/local/bin/my-guard.sh');
    expect(hooks.Stop?.map((g) => g.hooks[0]?.command)).toEqual(['say done', command]);
    expect(hooks.SessionStart).toEqual((userSettings.hooks as JsonObject).SessionStart);
    expect(Object.keys(hooks).sort()).toEqual([
      'PostToolUse',
      'PreToolUse',
      'SessionStart',
      'Stop',
      'UserPromptSubmit',
    ]);
    expect(next.model).toBe('opus');
    expect(next.statusLine).toEqual(userSettings.statusLine);
  });

  it('is idempotent and fully reversible', () => {
    const once = withOurHooks(userSettings, command);
    expect(withOurHooks(once, command)).toEqual(once);
    expect(withoutOurHooks(once)).toEqual(userSettings);
    expect(withoutOurHooks(withOurHooks({}, command))).toEqual({});
  });

  it('replaces an older install instead of duplicating it', () => {
    const old = withOurHooks(userSettings, `'/old/node' '/old/${HOOK_MARKER}.js' --storage '/s'`);
    const updated = withOurHooks(old, command);
    expect(JSON.stringify(updated)).not.toContain('/old/');
    expect(formatSettings(updated).split(HOOK_MARKER).length - 1).toBe(4);
  });

  it('keeps a user hook that shares a group with ours', () => {
    const shared: JsonObject = {
      hooks: {
        Stop: [
          {
            hooks: [
              { type: 'command', command },
              { type: 'command', command: 'say done' },
            ],
          },
        ],
      },
    };
    expect(withoutOurHooks(shared)).toEqual({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] },
    });
  });

  it('writes atomically with a backup, and verifies the result', async () => {
    const dir = await tempDir();
    const file = path.join(dir, '.claude', 'settings.local.json');
    const original = `${JSON.stringify(userSettings, null, 4)}\n`;
    await write(dir, '.claude/settings.local.json', original);
    const backups = path.join(await tempDir(), 'backups');

    const snapshot = await readSettings(file);
    const { backup } = await writeSettings(
      snapshot,
      withOurHooks(snapshot.value, command),
      backups,
    );
    expect(backup && (await fs.readFile(backup, 'utf8'))).toBe(original);
    const written = await readSettings(file);
    expect(hasOurHooks(written.value)).toBe(true);
    assertOnlyOurHooksChanged(userSettings, written.value);

    const again = await readSettings(file);
    await writeSettings(again, withoutOurHooks(again.value), backups);
    expect((await readSettings(file)).value).toEqual(userSettings);
  });

  it('creates the file when missing', async () => {
    const dir = await tempDir();
    const file = path.join(dir, '.claude', 'settings.local.json');
    const snapshot = await readSettings(file);
    expect(snapshot.exists).toBe(false);
    const { backup } = await writeSettings(
      snapshot,
      withOurHooks({}, command),
      path.join(dir, 'b'),
    );
    expect(backup).toBeUndefined();
    expect(hasOurHooks((await readSettings(file)).value)).toBe(true);
  });

  it('refuses invalid JSON and leaves the file untouched', async () => {
    const dir = await tempDir();
    const text = '{\n  // a comment\n  "model": "opus",\n}\n';
    await write(dir, 'settings.local.json', text);
    await expect(readSettings(path.join(dir, 'settings.local.json'))).rejects.toBeInstanceOf(
      SettingsParseError,
    );
    await write(dir, 'weird.json', '{"hooks": []}');
    await expect(readSettings(path.join(dir, 'weird.json'))).rejects.toBeInstanceOf(
      SettingsParseError,
    );
    expect(await readText(dir, 'settings.local.json')).toBe(text);
  });

  it('refuses to write if the file changed after it was read', async () => {
    const dir = await tempDir();
    await write(dir, 's.json', '{"model":"opus"}');
    const snapshot = await readSettings(path.join(dir, 's.json'));
    await write(dir, 's.json', '{"model":"sonnet"}');
    await expect(
      writeSettings(snapshot, withOurHooks(snapshot.value, command), dir),
    ).rejects.toThrow(/changed/);
    expect(await readText(dir, 's.json')).toBe('{"model":"sonnet"}');
  });

  it('refuses to write anything that changes other settings', () => {
    expect(() => {
      assertOnlyOurHooksChanged(userSettings, {
        ...withOurHooks(userSettings, command),
        model: 'haiku',
      });
    }).toThrow(/Verification failed/);
  });
});

describe('attribution through hook events', () => {
  it('rejecting a Claude edit keeps user changes made before Claude touched the file', async () => {
    const root = await initRepo({ 'a.ts': 'original\n' });
    const h = await Harness.start(root);
    const storage = path.dirname(h.store.dir);
    await configure(storage, root);

    await write(root, 'a.ts', 'original\nuser line\n'); // user, after the session started
    await runHook(storage, toolEvent('PreToolUse', root, path.join(root, 'a.ts')));
    await write(root, 'a.ts', 'original\nuser line\nclaude line\n');
    await runHook(storage, toolEvent('PostToolUse', root, path.join(root, 'a.ts')));
    await ingest(h, storage);

    const [change] = await h.detect();
    expect(change?.origin).toBe('claude');
    expect(change?.restoreTarget?.type).toBe('stored');
    const deps = {
      session: h.session,
      store: h.store,
      git: h.git,
      sensitive: new GlobSet([]),
      limits: h.limits,
    };
    await rejectMany(change ? [change] : [], deps);
    expect(await readText(root, 'a.ts')).toBe('original\nuser line\n');

    // The user's own change is still listed, now unattributed; rejecting it goes to the baseline.
    const [remaining] = await h.detect();
    expect(remaining?.origin).toBe('unattributed');
    await rejectMany(remaining ? [remaining] : [], deps);
    expect(await readText(root, 'a.ts')).toBe('original\n');
  });

  it('labels files changed after Claude’s edit', async () => {
    const root = await initRepo({ 'a.ts': 'original\n' });
    const h = await Harness.start(root);
    const storage = path.dirname(h.store.dir);
    await configure(storage, root);
    await runHook(storage, toolEvent('PreToolUse', root, path.join(root, 'a.ts')));
    await write(root, 'a.ts', 'claude\n');
    await runHook(storage, toolEvent('PostToolUse', root, path.join(root, 'a.ts')));
    await write(root, 'b.ts', 'made by a terminal command\n');
    await ingest(h, storage);
    expect((await h.detect()).map((c) => `${c.path}:${c.origin ?? ''}`)).toEqual([
      'a.ts:claude',
      'b.ts:unattributed',
    ]);

    await write(root, 'a.ts', 'claude\nformatter touched it\n');
    expect((await h.change('a.ts')).origin).toBe('claude-then-other');
  });

  it('tracks a Git-ignored file once Claude edits it', async () => {
    const root = await initRepo({ '.gitignore': '*.log\n', 'a.ts': 'a\n' });
    await write(root, 'build.log', 'existing log\n');
    const h = await Harness.start(root);
    const storage = path.dirname(h.store.dir);
    await configure(storage, root);
    expect(await h.detect()).toEqual([]);

    await runHook(storage, toolEvent('PreToolUse', root, path.join(root, 'build.log')));
    await write(root, 'build.log', 'claude rewrote the log\n');
    await runHook(storage, toolEvent('PostToolUse', root, path.join(root, 'build.log')));
    await ingest(h, storage);

    const change = await h.change('build.log');
    expect(change.kind).toBe('modified');
    await rejectMany([change], {
      session: h.session,
      store: h.store,
      git: h.git,
      sensitive: new GlobSet([]),
      limits: h.limits,
    });
    expect(await readText(root, 'build.log')).toBe('existing log\n');
  });

  it('does not hide an edit that raced the baseline capture', async () => {
    const root = await initRepo({ 'a.ts': 'original\n' });
    const storage = await tempDir();
    await configure(storage, root);
    // Claude edits before the session baseline is captured.
    await runHook(storage, toolEvent('PreToolUse', root, path.join(root, 'a.ts')));
    await write(root, 'a.ts', 'claude\n');
    await new Promise((r) => setTimeout(r, 5));
    const h = await Harness.start(root);
    expect(await h.detect()).toEqual([]); // the edit is inside the baseline...

    // ...until the hook event is applied.
    const events = await readPendingEvents(storage);
    for (const item of events) {
      if (isEditEvent(item.event)) {
        await applyEditEvent(h.session, item.event, { isIgnored: () => Promise.resolve(false) });
      }
    }
    // The pre-edit blob lives in the hook's storage; copy it where this harness reads blobs.
    const pre = events[0]?.event;
    if (pre && isEditEvent(pre) && pre.state.type === 'file') {
      await h.store.put(Buffer.from('original\n'));
    }
    const change = await h.change('a.ts');
    expect(change.kind).toBe('modified');
    await rejectMany([change], {
      session: h.session,
      store: h.store,
      git: h.git,
      sensitive: new GlobSet([]),
      limits: h.limits,
    });
    expect(await readText(root, 'a.ts')).toBe('original\n');
  });

  it('15/16. without hooks nothing is attributed and everything still works', async () => {
    const root = await initRepo({ 'a.ts': 'a\n' });
    const h = await Harness.start(root);
    await write(root, 'a.ts', 'changed\n');
    const [change] = await h.detect();
    expect(change?.origin).toBe('unattributed');
    expect(change?.restoreTarget).toBeUndefined();
    expect(await git(root, 'status', '--porcelain')).toBe(' M a.ts\n');
  });
});
