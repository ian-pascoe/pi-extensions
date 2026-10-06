---
"@ian-pascoe/pi-git-checkpoints": patch
---

Stop every Model Step from re-listing unchanged git-ignored files (such as `.husky/_/*`) as skipped paths in the session. Each checkpoint now records its ignored set only when it changes, and Restore still leaves those paths untouched, including paths whose ignore rule was later removed. Oversized files, submodules, nested repositories, and special files are still reported as skipped.
