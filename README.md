# Claude Review

Review, accept, and reject the file changes Claude Code makes in your workspace, using
VS Code's native diff editor. Claude Review works alongside the official Claude Code
extension: it never calls an AI model, never launches an agent, and never changes how Claude
Code works. It is an independent project and is not affiliated with Anthropic.

- A **Changes** panel in the Activity Bar lists every file changed since the review session
  started, grouped as Added, Modified, Deleted, and Renamed, with a Pending / Accepted /
  Rejected status for each.
- Click a file to open a **side-by-side diff** against its original content.
- **Accept** or **Reject** each file, or use **Accept All** / **Reject All**, and
  **Undo Last Review Action** if you change your mind.
- Your own uncommitted work (staged, unstaged, and untracked) is part of the original state
  and is never thrown away by a reject.

## Install

Build the package (or use a provided `.vsix`), then install it:

```bash
npm install
npm run package
code --install-extension claude-review-0.1.0.vsix
```

Or in VS Code: **Extensions** view → `…` menu → **Install from VSIX…**.

Requirements: VS Code 1.94 or later. Git is recommended; without it a reduced mode is used
(see below). Claude Code is optional: the extension reviews any change, whoever made it.

## Using it

1. Open a folder. A review session starts automatically and records the current state of
   the workspace as the **baseline**. No files are modified.
2. Work with Claude Code as usual. Changed files appear in the **Claude Review** panel and a
   pending count appears in the status bar.
3. Click a file to open its diff (**Original ↔ Current**). Use the ✓ / ↺ buttons in the
   editor title bar or the panel to accept or reject it. After a decision made in a diff,
   the next pending file opens.
4. Use **Review All**, **Accept All**, or **Reject All…** from the panel title bar for many
   files at once.

### What the actions do

| Action                       | Effect on files                                                                                                                                                | Effect on the review                                                                               |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| **Accept**                   | None. The file stays exactly as it is. Nothing is staged or committed.                                                                                         | The accepted content becomes the file's new baseline. Later edits show up as a new pending change. |
| **Reject**                   | Restores the file's original bytes (and executable bit). A file that did not exist is moved to the trash; a deleted file is recreated; a rename is moved back. | Recorded as rejected. A copy of the rejected content is kept.                                      |
| **Accept All**               | None.                                                                                                                                                          | Accepts every pending change, after a confirmation.                                                |
| **Reject All…**              | As Reject, for the files you leave selected in the preview.                                                                                                    | Shows every file and its effect first, then a confirmation with counts.                            |
| **Undo Last Review Action**  | Undoing an accept: none. Undoing a reject: writes the rejected content back.                                                                                   | Reverses the most recent decision; a batch counts as one.                                          |
| **Start New Review Session** | None.                                                                                                                                                          | The current workspace state becomes the new baseline.                                              |
| **End Review Session**       | None.                                                                                                                                                          | Stops tracking; pending changes simply stay in your workspace.                                     |

Reject and Undo are guarded:

- A file is only written if it is still exactly what you reviewed. If it changed in the
  meantime (you kept typing, a formatter ran, Claude edited it again), nothing is written and
  you are offered **Review Latest**.
- Every restore is written to a temporary file next to the target and moved into place
  atomically. The content being replaced is backed up first.
- A rename is restored all-or-nothing. If anything fails partway, the report lists exactly
  which paths were and were not written. Results are never reported as complete unless they
  are.
- Paths outside the workspace folder, inside `.git`, or reached through symbolic links that
  leave the workspace are refused.
- Only read-only Git commands are ever run. The extension never stages, commits, resets,
  checks out, stashes, or cleans.

## How changes are found

**In a Git repository** (recommended), starting a session records `HEAD` and copies the exact
bytes of every file that is staged, modified, deleted, or untracked at that moment. Clean files
are not copied: their original content is read back from `HEAD` through the repository's own
filters (line endings, LFS smudge). Changes are found from `git status`, from commits made
after the session started, and from file-watcher events, then compared byte-for-byte with the
baseline. A file edited and then put back drops off the list.

**Without Git** (reduced mode), starting a session copies every non-excluded file within the
size limits, and changes are found from file-watcher events. Workspaces with more than
`claudeReview.filesystemMode.maxFiles` files are not tracked in this mode.

**Files that are never copied** into extension storage: files matching
`claudeReview.snapshot.sensitivePatterns` (`.env`, keys, `.npmrc`, …), files larger than
`claudeReview.snapshot.maxFileSizeMB`, anything beyond the per-session size budget, and
symbolic links. Changes to them are still detected (by hash), but they cannot be rejected
automatically; the panel says so and Reject is disabled for them. Tracked files remain
restorable from Git.

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

With hooks:

- Each change is labeled **Claude**, **Claude, then edited**, or not attributed.
- Rejecting a file Claude edited restores it as it was **right before Claude's first edit**,
  so changes you made earlier survive. Your earlier change then stays listed on its own and
  can be rejected separately.
- Git-ignored files Claude edits become reviewable.
- A new prompt starts a fresh session when nothing is pending
  (`claudeReview.hooks.newSessionPerPrompt`). Pending changes are never hidden: if any remain,
  the current session continues.

The hook script always exits 0 and prints nothing, so it cannot block a tool call, change a
prompt, or add anything to Claude's context. It only writes into this extension's storage.
It runs with Node.js 18+ from your `PATH`, or with VS Code's bundled runtime if none is
found. Restart running Claude Code sessions after installing. Remove the hooks with
**Remove Claude Code Hooks…**; only the entries this extension added are removed. **Show
Claude Code Hook Status** reports what is installed and when the last hook event arrived.

Without hooks, everything still works through Git and file watching; changes simply are not
attributed to Claude.

## Limitations

- **Attribution of terminal commands.** Edits made through Claude's `Bash` tool (for example
  `sed -i`, code generators, `npm install`), formatters, and other processes are detected but
  shown as not attributed; the extension cannot know which process made them.
- **Mixed edits in one file.** If you and Claude both edit a file, the two cannot be separated
  line by line. Reject restores a whole file (to the state before Claude's first edit, with
  hooks; to the baseline, without). It refuses if the file changed after you reviewed it.
- **Not restored:** symbolic links, submodules, and Git-ignored files that were not captured
  (without hooks, ignored files are not tracked at all). Empty folders left behind after
  rejecting new files are not removed.
- **One folder, one window.** In a multi-root workspace only the first folder is reviewed.
  Opening the same folder in two VS Code windows at once is not supported (both windows
  share one storage area).
- **Several Claude sessions** editing one workspace at the same time share one review
  session.
- **Undo** is single-level per session (newest first, no redo), and a new session started by
  a prompt has its own, empty undo history.
- **Non-UTF-8 file names** in Git repositories are not supported.
- **Windows** has not been tested; the hook command uses POSIX shell quoting.
- **No default keyboard shortcuts.** Every action is in the Command Palette (under
  "Claude Review") and can be bound in Keyboard Shortcuts. The context key
  `claudeReview.inReviewDiff` is true while a review diff is focused.

## Storage, privacy, and retention

- All data stays on your machine in VS Code's per-workspace extension storage. Nothing is
  written inside your project except, if you choose to install them, the hook entries in
  `.claude/settings.local.json`.
- Stored: session metadata (paths, hashes, decisions), copies of original and rejected file
  contents, and backups of the Claude Code settings file. Not stored: prompt text,
  environment variables, or files matching the sensitive-file patterns.
- The active session is always kept. Ended sessions beyond
  `claudeReview.retention.maxEndedSessions` (default 5) or older than
  `claudeReview.retention.maxAgeDays` (default 30) are deleted, along with snapshots no
  remaining session uses. Snapshots written in the last hour are never deleted.

## Recovery

- **Changed your mind?** Use **Undo Last Review Action**. It survives VS Code restarts.
- **A rejected file you can no longer undo:** open it from the panel (filter to show
  Rejected). Its diff shows the rejected content on the left; copy what you need.
- **Manual recovery:** **Open Snapshot Storage Folder** reveals the storage directory:
  - `snapshots/<aa>/<rest-of-sha256>`: exact file contents, named by SHA-256;
  - `sessions/<id>.json`: each session's baselines and decisions, mapping paths to hashes;
  - `backups/`: copies of `.claude/settings.local.json` taken before each hook change.
- **After a crash:** the session, decisions, and undo history are reloaded on startup, and
  hook events written while VS Code was closed are applied.

## Troubleshooting

| Symptom                                      | What to check                                                                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| The panel says "No review session is active" | Run **Start New Review Session**, or enable `claudeReview.autoTrack`.                                                          |
| A change is missing                          | Run **Refresh**. Check `claudeReview.exclude`. Git-ignored files are only tracked when Claude edits them with hooks installed. |
| Reject is disabled for a file                | Its original content was not captured (sensitive, too large, symlink). The tooltip gives the reason.                           |
| "Changed after you reviewed it"              | The file changed since the diff was computed. Use **Review Latest** and decide again.                                          |
| Hooks don't seem to run                      | **Show Claude Code Hook Status**; restart Claude Code; check that `.claude/settings.local.json` is valid JSON.                 |
| Something else                               | **Show Log** opens the "Claude Review" output channel with details of every action.                                            |

## Settings

| Setting                                   | Default                     | Purpose                                            |
| ----------------------------------------- | --------------------------- | -------------------------------------------------- |
| `claudeReview.autoTrack`                  | `true`                      | Start a session automatically when a folder opens. |
| `claudeReview.exclude`                    | `node_modules`, `.DS_Store` | Paths never tracked.                               |
| `claudeReview.snapshot.sensitivePatterns` | `.env`, keys, …             | Files never copied into storage.                   |
| `claudeReview.snapshot.maxFileSizeMB`     | `5`                         | Larger files are hashed, not copied.               |
| `claudeReview.snapshot.maxTotalSizeMB`    | `200`                       | Copy budget per session start.                     |
| `claudeReview.filesystemMode.maxFiles`    | `20000`                     | File limit without Git.                            |
| `claudeReview.confirmReject`              | `true`                      | Confirm single-file rejects.                       |
| `claudeReview.openNextAfterDecision`      | `true`                      | Open the next pending diff after deciding.         |
| `claudeReview.retention.maxEndedSessions` | `5`                         | Ended sessions kept.                               |
| `claudeReview.retention.maxAgeDays`       | `30`                        | Maximum age of ended sessions.                     |
| `claudeReview.hooks.newSessionPerPrompt`  | `true`                      | New session per prompt when nothing is pending.    |
| `claudeReview.hooks.notifyOnStop`         | `true`                      | Notify when Claude finishes.                       |

## Development

```bash
npm install
npm run build             # bundle dist/extension.js and dist/hook.js with esbuild
npm run check             # typecheck + lint + format check + unit tests
npm run test:integration  # Mocha tests inside an Extension Development Host
npm run test:e2e          # real Claude Code CLI; needs `claude` logged in, uses a little usage
npm run package           # produce the .vsix
```

Press <kbd>F5</kbd> ("Run Extension") to launch an Extension Development Host.

Unit and safety tests only ever touch temporary directories and throwaway Git repositories,
with Git's global configuration isolated. Integration tests use the VS Code installed at
`/Applications/Visual Studio Code.app` when present (or `CLAUDE_REVIEW_VSCODE_PATH`), and a
fresh temporary workspace.

| Path             | Responsibility                                                                 |
| ---------------- | ------------------------------------------------------------------------------ |
| `src/extension/` | Activation, the review controller, hook integration, configuration             |
| `src/core/`      | Pure domain logic (paths, globs, session model); no `vscode` import            |
| `src/services/`  | Git (read-only), hashing, baseline capture, change detection, restore, actions |
| `src/storage/`   | Snapshot store, session store, retention                                       |
| `src/hooks/`     | Hook protocol, hook script, settings-file installer, hook event ingestion      |
| `src/providers/` | TreeView, diff opener, read-only content provider                              |
| `src/commands/`  | Review commands, previews, reports, status bar                                 |
| `src/test/`      | `unit/` (Vitest), `integration/` (VS Code), `e2e/` (real Claude Code)          |
