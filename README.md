# Claude Review

Review, accept, and reject the file changes Claude Code makes in your workspace, using
VS Code's native diff editor. Claude Review works alongside the official Claude Code
extension: it never calls an AI model, never launches an agent, and never changes how
Claude Code works.

> **Status:** early development (Phase 1, foundation). The panel is in place; change
> detection, diffs, and accept/reject come in the next phases.

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
