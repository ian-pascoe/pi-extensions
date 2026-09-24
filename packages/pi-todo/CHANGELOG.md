# @ian-pascoe/pi-todo

## 0.1.3

### Patch Changes

- e6620c4: Keep Todo snapshots working after compaction on Pi 0.87. Compaction checkpoints now carry a system snapshot that `context` handlers never receive, so Todo projection anchors on the first conversation message instead of failing with "anchor is missing or ambiguous".

## 0.1.2

### Patch Changes

- d839d25: Preserve conversation cache prefixes by projecting immutable Todo snapshots at stable journal positions, including across tool groups and compaction.

## 0.1.1

### Patch Changes

- 1a2e2b9: Remove lint workarounds from package code

## 0.1.0

### Minor Changes

- 304857e: Add session-native Todo List tracking with branch-aware persistence, hidden model context, a compact widget, custom transcript rendering, and the `/todo clear` command.
