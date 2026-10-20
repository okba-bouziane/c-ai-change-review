# Claude Review

Review, accept, and reject the file changes Claude Code makes in your workspace, using
VS Code's native diff editor. Claude Review works alongside the official Claude Code
extension: it never calls an AI model, never launches an agent, and never changes how
Claude Code works.

> **Status:** early development (Phase 5). Changes are detected against a safe baseline,
> reviewed in native diffs, accepted or rejected per file or in batches, and undoable.
> Optional Claude Code hooks add exact pre-edit snapshots and attribution.

## Claude Code hooks (optional)

Run **Claude Review: Set Up Claude Code Hooks…** to add four hooks to this workspace's
`.claude/settings.local.json`. You see the exact change before anything is written; every
other setting and hook is kept, and the previous file is backed up in extension storage.

| Hook                                                   | Why                                                  |
| ------------------------------------------------------ | ---------------------------------------------------- |
| `PreToolUse` on `Write\|Edit\|MultiEdit\|NotebookEdit` | Copies the file just before Claude edits it          |
| `PostToolUse` on the same tools                        | Records what Claude wrote, to tell later edits apart |
| `UserPromptSubmit`                                     | Marks a new task (the prompt text is not stored)     |
| `Stop`                                                 | Offers the review when Claude finishes               |

The hook script always exits 0 and prints nothing, so it cannot block a tool call, change a
prompt, or add anything to Claude's context. It only writes into this extension's storage.
Remove the hooks with **Remove Claude Code Hooks…**; only the entries this extension added
are removed.

Without hooks, everything still works through Git and file watching; changes simply are not
attributed to Claude.

### Limits of attribution

- Edits made through Claude's `Bash` tool (for example `sed -i`, code generators, `npm
install`), formatters, and other processes are detected but shown as _not attributed_.
- If you edit a file that Claude also edits, Claude's part cannot be separated line by line.
  Reject restores the file as it was right before Claude's first edit; anything changed
  after that (by anyone) is reverted with it, and Reject refuses if the file changed after
  you reviewed it.
- Several Claude Code sessions editing the same workspace at once share one review session.

## Testing

```bash
npm run test:unit         # unit and safety tests (temporary repositories only)
npm run test:integration  # inside an Extension Development Host
npm run test:e2e          # real Claude Code CLI; needs `claude` logged in, uses a little usage
```

## Development

Requirements: Node.js 20+, npm, VS Code 1.94+.

```bash
npm install
npm run build          # bundle to dist/ with esbuild
npm run check          # typecheck + lint + format check + unit tests
npm run test:integration   # runs tests inside an Extension Development Host
npm run package        # produce a .vsix
```

Press <kbd>F5</kbd> in VS Code ("Run Extension") to launch an Extension Development Host.

Integration tests use the VS Code installed at
`/Applications/Visual Studio Code.app` when present, or the binary named by
`CLAUDE_REVIEW_VSCODE_PATH`; otherwise `@vscode/test-electron` downloads a copy. They
always run in a fresh temporary workspace.

## Layout

| Path                    | Responsibility                                                  |
| ----------------------- | --------------------------------------------------------------- |
| `src/extension/`        | Activation, wiring, disposal                                    |
| `src/core/`             | Pure domain logic, no `vscode` import (unit-tested with Vitest) |
| `src/providers/`        | TreeView and other VS Code providers                            |
| `src/test/unit/`        | Vitest unit tests                                               |
| `src/test/integration/` | Mocha tests run inside VS Code via `@vscode/test-cli`           |
