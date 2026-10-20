# Changelog

## 0.1.0 (unreleased)

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
