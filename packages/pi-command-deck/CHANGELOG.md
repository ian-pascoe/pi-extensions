# @ian-pascoe/pi-command-deck

## 0.2.2

### Patch Changes

- d13a4b9: The Pi Command Deck troubleshooting skill now points at the package's `GLOSSARY.md`, which replaces `CONTEXT.md` as the vocabulary file.

## 0.2.1

### Patch Changes

- Updated dependencies [7ab488c]
- Updated dependencies [eed4468]
- Updated dependencies [58a2ce1]
  - @ian-pascoe/pi-utils@0.6.0

## 0.2.0

### Minor Changes

- 4ef1998: The Command Deck footer now follows Pi's footer conventions (extension statuses sorted by key, joined by a space, truncated with a dim `...`), the Worktree Snapshot uses plain Unicode symbols instead of Nerd Font icons, and warnings are prefixed `Command Deck:`. Requires Pi 1.1.0 or newer.

### Patch Changes

- Updated dependencies [4ef1998]
- Updated dependencies [4ef1998]
  - @ian-pascoe/pi-utils@0.5.0

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
