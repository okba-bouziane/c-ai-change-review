/**
 * End-to-end check against the real Claude Code CLI (`npm run test:e2e`).
 *
 * Installs the hooks into a throwaway Git repository with the same installer the extension
 * uses, asks Claude Code to make a small edit, and verifies that Claude completed normally,
 * the hooks recorded the edit, and the edit can be attributed and rejected. Requires an
 * authenticated `claude` on PATH and uses a small amount of model usage. Never run as part
 * of `npm test`.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as esbuild from 'esbuild';
import { afterAll, describe, expect, it } from 'vitest';
import { GlobSet } from '../../core/glob';
import { applyEditEvent, deleteEvent, readPendingEvents } from '../../hooks/hookEvents';
import { HOOK_CONFIG_FILE, isEditEvent, type HookConfig } from '../../hooks/protocol';
import {
  buildHookCommand,
  HOOK_MARKER,
  readSettings,
  withOurHooks,
  writeSettings,
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
} from '../unit/helpers/workspace';

afterAll(cleanupTempDirs);

function runClaude(
  cwd: string,
  prompt: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'claude',
      [
        '-p',
        prompt,
        '--permission-mode',
        'acceptEdits',
        '--model',
        'haiku',
        '--output-format',
        'json',
      ],
      { cwd, env: process.env },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
    child.stdin.end();
  });
}

describe('real Claude Code with Claude Review hooks', () => {
  it('runs normally, and its edit is recorded, attributed, and rejectable', async () => {
    const root = await initRepo({
      'greeting.txt': 'hello world\n',
      'other.txt': 'leave me alone\n',
    });
    await git(root, 'config', 'user.name', 'Test'); // repo-local; the global config is untouched
    // The user has uncommitted work before Claude starts.
    await fs.writeFile(path.join(root, 'notes.md'), 'my uncommitted notes\n');
    const h = await Harness.start(root);
    const storage = path.dirname(h.store.dir);

    const outDir = await tempDir();
    const script = path.join(outDir, `${HOOK_MARKER}.js`);
    await esbuild.build({
      entryPoints: ['src/hooks/hookScript.ts'],
      outfile: script,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node18',
      logLevel: 'silent',
    });
    const config: HookConfig = {
      version: 1,
      root,
      exclude: [],
      sensitive: ['.env'],
      maxFileSize: 5 * 1024 * 1024,
    };
    await fs.writeFile(path.join(storage, HOOK_CONFIG_FILE), JSON.stringify(config));
    const settingsFile = path.join(root, '.claude', 'settings.local.json');
    const snapshot = await readSettings(settingsFile);
    const command = buildHookCommand(
      { executable: process.execPath, electron: false },
      script,
      storage,
    );
    await writeSettings(
      snapshot,
      withOurHooks(snapshot.value, command),
      path.join(storage, 'backups'),
    );
    h.session.baselines['.claude/settings.local.json'] = { type: 'absent' };

    const result = await runClaude(
      root,
      'In greeting.txt, replace the word "hello" with "goodbye". Change nothing else and do not touch any other file.',
    );
    expect(result.code, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout) as { is_error?: boolean; subtype?: string };
    expect(output.is_error).toBe(false);
    expect(await readText(root, 'greeting.txt')).toBe('goodbye world\n');
    expect(await readText(root, 'other.txt')).toBe('leave me alone\n');

    const events = await readPendingEvents(storage);
    const kinds = events.map((e) => e.event.type);
    expect(kinds).toContain('prompt');
    expect(kinds).toContain('pre');
    expect(kinds).toContain('post');
    expect(kinds).toContain('stop');

    const gitApi = new Git(root);
    for (const item of events) {
      if (isEditEvent(item.event)) {
        await applyEditEvent(h.session, item.event, {
          isIgnored: async (key) => (await gitApi.checkIgnore([key])).has(key),
        });
      }
      await deleteEvent(item);
    }
    const changes = await h.detect();
    const greeting = changes.find((c) => c.path === 'greeting.txt');
    expect(greeting?.origin).toBe('claude');
    expect(changes.find((c) => c.path === 'notes.md')).toBeUndefined();

    await rejectMany(greeting ? [greeting] : [], {
      session: h.session,
      store: h.store,
      git: h.git,
      sensitive: new GlobSet([]),
      limits: h.limits,
    });
    expect(await readText(root, 'greeting.txt')).toBe('hello world\n');
    expect(await readText(root, 'notes.md')).toBe('my uncommitted notes\n');
  }, 240_000);
});
