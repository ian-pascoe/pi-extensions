---
"@ian-pascoe/pi-git-checkpoints": patch
---

Stop recording git-ignored paths in each checkpoint's `skipped_paths`, which bloated session entries with every unchanged ignored file (for example `.husky/_/*`). Ignored paths are now derived from live ignore rules at Restore time and still left untouched; real capture skips (oversized untracked files, submodules, nested repositories, special files) are still reported.
