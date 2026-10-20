# Changelog

## 0.1.0 (unreleased)

- Change detection: review sessions with a baseline captured when the session starts, including
  staged, unstaged, and untracked work. Git mode copies only dirty and untracked files; clean
  files are read back from HEAD. Filesystem mode (no Git) copies every file within limits.
- Safe restore engine: per-change pre-checks, conflict detection, atomic writes, backups of
  replaced content, path-traversal and symlink-escape protection. Read-only Git commands only.
- Foundation: Activity Bar view with grouped Changed Files tree, empty states, refresh, and log.
