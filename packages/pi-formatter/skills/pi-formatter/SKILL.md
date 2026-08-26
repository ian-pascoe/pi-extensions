---
name: pi-formatter
description: Configure or diagnose Pi Formatter when post-edit formatting is skipped, targets the wrong file or root, or returns a command failure.
license: MIT
---

# Pi Formatter

1. Read [`../../README.md`](../../README.md)'s Settings and Supported mutations sections.
2. Capture one failing mutation, its destination path, startup warning, and formatter warning.
3. Resolve the effective Formatter Definition, then check its file selector, Activation Gate, root, working directory, and `$FILE` mode against that path.
4. Verify the executable and arguments with a safe check or an approved reproduction.
5. For a requested change, edit one settings layer, validate JSON, reload Pi, and repeat the same mutation.
6. Finish when the same destination formats or the exact selector, activation, root, spawn, timeout, or exit boundary is evidenced.

A formatter failure warns but does not fail the original mutation.
