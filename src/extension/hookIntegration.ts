import { execFile } from 'node:child_process';
import { watch, type FSWatcher } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { inScope, relativeTo } from '../core/paths';
import {
  EVENTS_DIR,
  HOOK_CONFIG_FILE,
  HOOK_PROTOCOL_VERSION,
  type HookConfig,
} from '../hooks/protocol';
import {
  buildHookCommand,
  formatSettings,
  hasOurHooks,
  HOOK_EVENTS,
  HOOK_MARKER,
  readSettings,
  SettingsParseError,
  withOurHooks,
  withoutOurHooks,
  writeSettings,
  type HookRuntime,
} from '../hooks/settingsFile';
import { REVIEW_SCHEME, reviewUri } from '../providers/reviewContentProvider';
import { Git } from '../services/git';
import { readConfig, SECTION } from './config';
import type { ReviewController } from './reviewController';

const SETTINGS_RELATIVE = path.join('.claude', 'settings.local.json');

/**
 * Optional integration with Claude Code's documented hooks. Nothing here runs unless the
 * user installs the hooks with "Set Up Claude Code Hooks"; without them the extension
 * works as a Git/filesystem review tool.
 */
export class HookIntegration implements vscode.Disposable {
  private watcher: FSWatcher | undefined;
  private debounce: NodeJS.Timeout | undefined;
  private lastEventAt: number | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly folder: vscode.WorkspaceFolder,
    private readonly storageDir: string,
    private readonly controller: ReviewController,
    private readonly log: vscode.LogOutputChannel,
  ) {
    this.disposables.push(
      vscode.commands.registerCommand('claudeReview.setupHooks', () => this.setup()),
      vscode.commands.registerCommand('claudeReview.removeHooks', () => this.remove()),
      vscode.commands.registerCommand('claudeReview.hookStatus', () => this.showStatus()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(SECTION)) {
          void this.writeHookConfig();
        }
      }),
    );
  }

  get settingsFile(): string {
    return path.join(this.folder.uri.fsPath, SETTINGS_RELATIVE);
  }

  private get scriptPath(): string {
    return path.join(this.context.globalStorageUri.fsPath, 'hook', `${HOOK_MARKER}.js`);
  }

  /** Keeps the hook's config current and starts listening for its events. */
  async start(): Promise<void> {
    await this.writeHookConfig();
    const installed = await this.isInstalled().catch(() => false);
    if (installed) {
      // Keep the installed script current with this extension version.
      await this.installScript();
    }
    const eventsDir = path.join(this.storageDir, EVENTS_DIR);
    await fs.mkdir(eventsDir, { recursive: true, mode: 0o700 });
    try {
      this.watcher = watch(eventsDir, () => {
        this.scheduleIngest();
      });
    } catch (e) {
      this.log.warn(`Cannot watch hook events: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.scheduleIngest(); // Events written while VS Code was closed.
  }

  private scheduleIngest(): void {
    if (this.debounce) {
      clearTimeout(this.debounce);
    }
    this.debounce = setTimeout(() => {
      this.debounce = undefined;
      this.lastEventAt = Date.now();
      void this.controller.ingestHookEvents(this.storageDir, async (key) => {
        const session = this.controller.activeSession;
        if (session?.mode !== 'git') {
          return false;
        }
        const ignored = await new Git(session.root).checkIgnore([key]);
        return ignored.has(key);
      });
    }, 100);
  }

  async isInstalled(): Promise<boolean> {
    return hasOurHooks((await readSettings(this.settingsFile)).value);
  }

  private async writeHookConfig(): Promise<void> {
    const config = readConfig(this.folder);
    const vs = vscode.workspace.getConfiguration(SECTION, this.folder);
    const hookConfig: HookConfig = {
      version: HOOK_PROTOCOL_VERSION,
      root: this.folder.uri.fsPath,
      exclude: vs.get<string[]>('exclude', []),
      sensitive: vs.get<string[]>('snapshot.sensitivePatterns', []),
      maxFileSize: config.limits.maxFileSize,
    };
    await fs.mkdir(this.storageDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(this.storageDir, HOOK_CONFIG_FILE), JSON.stringify(hookConfig), {
      mode: 0o600,
    });
  }

  private async installScript(): Promise<void> {
    const source = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'hook.js').fsPath;
    const content = await fs.readFile(source);
    await fs.mkdir(path.dirname(this.scriptPath), { recursive: true });
    const existing = await fs.readFile(this.scriptPath).catch(() => undefined);
    if (!existing?.equals(content)) {
      const temp = `${this.scriptPath}.tmp`;
      await fs.writeFile(temp, content, { mode: 0o644 });
      await fs.rename(temp, this.scriptPath);
    }
  }

  async setup(): Promise<void> {
    let snapshot;
    try {
      snapshot = await readSettings(this.settingsFile);
    } catch (e) {
      void vscode.window.showErrorMessage(
        e instanceof SettingsParseError
          ? e.message
          : `Cannot read ${this.settingsFile}: ${String(e)}`,
        { modal: true },
      );
      return;
    }
    const runtime = await resolveRuntime();
    await this.installScript();
    await this.writeHookConfig();
    const command = buildHookCommand(runtime, this.scriptPath, this.storageDir);
    const next = withOurHooks(snapshot.value, command);
    if (formatSettings(next) === snapshot.text) {
      void vscode.window.showInformationMessage(
        'Claude Code hooks are already set up for this workspace.',
      );
      return;
    }

    await this.preview(snapshot.text, formatSettings(next), 'Proposed');
    const notIgnored = await this.settingsFileNotIgnored();
    const choice = await vscode.window.showWarningMessage(
      `Add Claude Review hooks to ${SETTINGS_RELATIVE}?`,
      {
        modal: true,
        detail: [
          'The preview shows the exact change. These hooks are added:',
          ...HOOK_EVENTS.map(
            (h) => `• ${h.event}${h.matcher ? ` (${h.matcher})` : ''}: ${h.purpose}`,
          ),
          '',
          'The hook script always exits successfully, prints nothing, and never blocks Claude Code. ' +
            'All other settings and hooks in the file are kept unchanged' +
            (snapshot.exists ? ', and a backup of the file is saved in extension storage.' : '.'),
          runtime.electron
            ? "Node.js was not found, so the hook uses VS Code's bundled runtime."
            : `Runtime: ${runtime.executable}`,
          notIgnored
            ? `Note: ${SETTINGS_RELATIVE} is not ignored by Git. Add it to .gitignore if it should not be committed.`
            : '',
          'Running Claude Code sessions may need a restart to pick up the change.',
        ]
          .filter((l) => l !== '')
          .join('\n'),
      },
      'Install Hooks',
    );
    await this.closePreview();
    if (choice !== 'Install Hooks') {
      return;
    }
    await this.write(snapshot, next, 'installed');
  }

  async remove(): Promise<void> {
    let snapshot;
    try {
      snapshot = await readSettings(this.settingsFile);
    } catch (e) {
      void vscode.window.showErrorMessage(
        e instanceof SettingsParseError
          ? e.message
          : `Cannot read ${this.settingsFile}: ${String(e)}`,
        { modal: true },
      );
      return;
    }
    if (!hasOurHooks(snapshot.value)) {
      void vscode.window.showInformationMessage(
        'No Claude Review hooks are set up in this workspace.',
      );
      return;
    }
    const next = withoutOurHooks(snapshot.value);
    const choice = await vscode.window.showWarningMessage(
      `Remove Claude Review hooks from ${SETTINGS_RELATIVE}?`,
      {
        modal: true,
        detail:
          'Only the hooks this extension added are removed; every other setting and hook is kept. ' +
          'Change detection keeps working through Git and file watching.',
      },
      'Remove Hooks',
    );
    if (choice === 'Remove Hooks') {
      await this.write(snapshot, next, 'removed');
    }
  }

  private async write(
    snapshot: Awaited<ReturnType<typeof readSettings>>,
    next: Record<string, unknown>,
    verb: 'installed' | 'removed',
  ): Promise<void> {
    const key = this.controller.keyForFile(this.settingsFile);
    const wasPending = key !== undefined && this.controller.item(key)?.status === 'pending';
    try {
      const { backup } = await writeSettings(snapshot, next, path.join(this.storageDir, 'backups'));
      this.log.info(
        `Claude Code hooks ${verb} in ${this.settingsFile}${backup ? ` (backup: ${backup})` : ''}`,
      );
    } catch (e) {
      void vscode.window.showErrorMessage(
        `Could not update ${SETTINGS_RELATIVE}: ${e instanceof Error ? e.message : String(e)}`,
        { modal: true },
      );
      return;
    }
    // Our own edit to the settings file is not something to review.
    await this.controller.refresh();
    if (key !== undefined && !wasPending && this.controller.item(key)?.status === 'pending') {
      await this.controller.accept([key], { recordHistory: false });
    }
    void vscode.window.showInformationMessage(
      verb === 'installed'
        ? 'Claude Code hooks installed. Restart running Claude Code sessions to use them.'
        : 'Claude Review hooks removed.',
    );
  }

  private async showStatus(): Promise<void> {
    let installed: string;
    try {
      installed = (await this.isInstalled()) ? 'installed' : 'not installed';
    } catch (e) {
      installed = `settings file unreadable (${e instanceof Error ? e.message : String(e)})`;
    }
    const scriptExists = await fs
      .access(this.scriptPath)
      .then(() => true)
      .catch(() => false);
    const lines = [
      `Hooks in ${SETTINGS_RELATIVE}: ${installed}`,
      `Hook script: ${scriptExists ? this.scriptPath : 'missing'}`,
      `Last hook activity seen: ${this.lastEventAt ? new Date(this.lastEventAt).toLocaleString() : 'none since VS Code started'}`,
      '',
      'Without hooks, changes are still detected through Git and file watching, but cannot be ' +
        'attributed to Claude Code, and files edited by Claude that Git ignores are not tracked.',
    ];
    void vscode.window.showInformationMessage('Claude Code hook status', {
      modal: true,
      detail: lines.join('\n'),
    });
  }

  private async preview(before: string, after: string, label: string): Promise<void> {
    const left = reviewUri(
      'settings.local.json',
      '__hooks__',
      { t: 'message', m: before },
      'Current',
    );
    const right = reviewUri('settings.local.json', '__hooks__', { t: 'message', m: after }, label);
    await vscode.commands.executeCommand(
      'vscode.diff',
      left,
      right,
      `${SETTINGS_RELATIVE} (Current ↔ ${label})`,
      { preview: true },
    );
  }

  private async closePreview(): Promise<void> {
    const tabs = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .filter(
        (t) =>
          t.input instanceof vscode.TabInputTextDiff &&
          t.input.original.scheme === REVIEW_SCHEME &&
          t.input.original.query.includes('k=__hooks__'),
      );
    if (tabs.length > 0) {
      await vscode.window.tabGroups.close(tabs, true);
    }
  }

  private async settingsFileNotIgnored(): Promise<boolean> {
    const session = this.controller.activeSession;
    if (session?.mode !== 'git') {
      return false;
    }
    const key = relativeTo(session.root, this.settingsFile);
    if (key === undefined || !inScope(session.scope, key)) {
      return false;
    }
    const ignored = await new Git(session.root).checkIgnore([key]).catch(() => new Set<string>());
    return !ignored.has(key);
  }

  dispose(): void {
    this.watcher?.close();
    if (this.debounce) {
      clearTimeout(this.debounce);
    }
    this.disposables.forEach((d) => {
      d.dispose();
    });
  }
}

/** Finds Node.js 18+ on PATH; otherwise falls back to VS Code's Electron in Node mode. */
export async function resolveRuntime(): Promise<HookRuntime> {
  const found = await new Promise<string | undefined>((resolve) => {
    execFile(
      'node',
      ['-p', 'process.execPath + "\\n" + process.versions.node'],
      { timeout: 5000, windowsHide: true },
      (err, stdout) => {
        resolve(err ? undefined : stdout);
      },
    );
  });
  const [execPath, version] = (found ?? '').trim().split('\n');
  const major = Number(version?.split('.')[0]);
  if (execPath && major >= 18) {
    return { executable: execPath, electron: false };
  }
  return { executable: process.execPath, electron: true };
}
