---
name: pi-git-checkpoints
description: Configure or diagnose Pi Git Checkpoints for retention, capture, Restore, /checkpoint, or tree-navigation failures.
license: MIT
---

# Pi Git Checkpoints

1. Read the relevant capture, Restore, command, or retention section of [`../../README.md`](../../README.md).
2. Obtain `/checkpoint status`. Record the mode, store, last failure, retention, and undo state.
3. For Restore trouble, identify the Navigation Transition and compare the observed result with the documented Restore invariants.
4. For retention changes, identify the effective settings layer, make the requested scoped edit, validate JSON, and reload Pi.
5. Finish when status after reload shows the intended retention or the exact capture or Restore boundary responsible for the result.

`/checkpoint undo` applies only to the latest successful Restore.
