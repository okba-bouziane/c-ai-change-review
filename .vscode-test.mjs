import { defineConfig } from '@vscode/test-cli';
import { existsSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Prefer the locally installed VS Code so tests don't download a copy.
// Override with CLAUDE_REVIEW_VSCODE_PATH, or unset to let test-electron download one.
const localVSCode =
  process.env.CLAUDE_REVIEW_VSCODE_PATH ??
  '/Applications/Visual Studio Code.app/Contents/MacOS/Code';

// Integration tests always run against a throwaway workspace, never a real project.
const workspace = mkdtempSync(join(tmpdir(), 'claude-review-it-'));

export default defineConfig({
  files: 'out/test/integration/**/*.test.js',
  workspaceFolder: workspace,
  ...(existsSync(localVSCode) ? { useInstallation: { fromPath: localVSCode } } : {}),
  launchArgs: ['--disable-extensions', '--disable-workspace-trust'],
  mocha: { ui: 'tdd', timeout: 60000 },
});
