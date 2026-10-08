# @ian-pascoe/pi-command-deck

## 0.1.2

### Patch Changes

- Updated dependencies [ac8fb7a]
- Updated dependencies [9b5cae5]
  - @ian-pascoe/pi-utils@0.4.0

## 0.1.1

### Patch Changes

- 0ea1e75: Declare Pi `>=0.99.0` as the peer range for `@earendil-works/pi-coding-agent`, `pi-ai`, `pi-agent-core`, and `pi-tui`, replacing `*`. Installing against an older Pi now warns at install time instead of failing when a package uses an API that Pi release lacks. Pi Utils keeps its Pi peer optional.
- Updated dependencies [0ea1e75]
  - @ian-pascoe/pi-utils@0.3.1

## 0.1.0

### Minor Changes

- bfd2f7c: Add Pi Command Deck: a compact, theme-following prompt editor with Vim modes (insert, normal, replace, visual, visual-line, ex, and search), operators, text objects, counts, `.` repeat, grouped undo and redo, `:` dispatch to Pi commands, and yanks copied to the system clipboard; a Deck Header with the working directory, branch, Worktree Snapshot, model, and thinking level; a Mode Rail with the Vim mode, cache hit rate, and context usage; and a Status Footer of extension statuses. It replaces `@ian-pascoe/pi-git-status-widget`, which is retired.
