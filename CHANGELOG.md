# Changelog

## 0.1.0 (unreleased)

- Optional Claude Code hook integration (Set Up / Remove Claude Code Hooks, Hook Status):
  PreToolUse/PostToolUse on Write|Edit|MultiEdit|NotebookEdit, UserPromptSubmit, and Stop,
  added to `.claude/settings.local.json` after a preview, with a backup, preserving every
  other setting and hook. The hook script always exits 0, prints nothing, and never stores
  prompt text.
- Attribution: changes are labeled as made by Claude, by Claude and then something else, or
  not attributed. Rejecting a Claude edit restores the file as it was right before Claude
  first edited it, so earlier changes by others survive. Git-ignored files Claude edits
  become reviewable. A new prompt starts a fresh session when nothing is pending, and a
  notification offers the review when Claude stops.

- Batch review: Review All, Accept All (confirmation), and Reject All (preview with per-file
  selection, confirmation with counts by change kind, cancellable progress). Partial results
  are reported exactly; nothing is reported as done unless it was.
- Undo Last Review Action: reverses the last accept/reject (a batch counts as one action).
  Undoing a reject only writes files that are still exactly as the reject left them.
- End Review Session, a status bar pending count, and welcome views for "no session".
- Session persistence with undo history across reloads; retention of ended sessions and
  cleanup of unused snapshots.

- Diff review: native side-by-side diffs against the review baseline (read-only left side),
  with clear placeholders for added, deleted, binary, and uncaptured files.
- Per-file Accept (keeps content, moves the baseline forward, never stages or commits) and
  Reject (safe restore with confirmation and conflict dialogs), from the panel, context menu,
  diff editor title bar, or Command Palette. Decisions are saved with the session.
- Panel: status icons, click to review, Review Next Pending File, and a status filter.

- Change detection: review sessions with a baseline captured when the session starts, including
  staged, unstaged, and untracked work. Git mode copies only dirty and untracked files; clean
  files are read back from HEAD. Filesystem mode (no Git) copies every file within limits.
- Safe restore engine: per-change pre-checks, conflict detection, atomic writes, backups of
  replaced content, path-traversal and symlink-escape protection. Read-only Git commands only.
- Foundation: Activity Bar view with grouped Changed Files tree, empty states, refresh, and log.
