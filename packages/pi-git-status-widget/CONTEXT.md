# Git Status Widget context

## Glossary

- **Worktree Snapshot**: the branch and ahead, behind, conflicted, untracked, and modified counts derived from one Git porcelain-v2 query.
- **Widget Refresh**: an attempt to render a new Worktree Snapshot on session start, input, tool completion, or the two-second polling interval.

A failed Widget Refresh hides the widget rather than displaying stale or partial status.
