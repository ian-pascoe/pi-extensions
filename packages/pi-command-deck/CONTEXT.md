# Command Deck context

Command Deck replaces Pi's prompt editor and footer with a compact, theme-following prompt that edits text through Vim Modes.

## Glossary

- **Command Deck**: the replacement prompt editor, including its Deck Header and Mode Rail.
- **Deck Header**: the Command Deck's top border, showing the working directory, branch, Worktree Snapshot, model, and thinking level.
- **Mode Rail**: the Command Deck's bottom border, showing the current Vim Mode with pending keys, the cache hit rate, and context usage.
  _Avoid_: Deck Baseline, status line
- **Status Footer**: the replacement Pi footer, which shows only extension statuses.
- **Vim Mode**: the editing state that interprets keys: insert, normal, replace, visual, visual-line, ex, or search.
- **Worktree Snapshot**: the ahead, behind, conflicted, untracked, and modified counts derived from one Git porcelain-v2 query.
