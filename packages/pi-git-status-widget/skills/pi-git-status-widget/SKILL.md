---
name: pi-git-status-widget
description: Diagnose Pi Git Status Widget when its Worktree Snapshot is missing, stale, or inconsistent with git status.
license: MIT
---

# Pi Git Status Widget

1. Read [`../../README.md`](../../README.md)'s display behavior.
2. Confirm an interactive UI, a Git worktree, and the intended `git` executable.
3. Run this evidence query from Pi's working directory:

   ```sh
   git status --porcelain=v2 --branch --untracked-files=normal
   ```

4. Compare every reported category with the Worktree Snapshot.
5. Wait one documented refresh interval and trigger a refresh before classifying the snapshot as stale.
6. Treat the extension as configuration-free. Finish when the snapshot matches Git or one named UI, worktree, executable, or load boundary explains its absence.
