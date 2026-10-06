---
name: pi-formatter
description: Configure or diagnose Pi Formatter when post-edit formatting is skipped, targets the wrong file or root, or returns a command failure.
license: MIT
disable-model-invocation: true
---

# Pi Formatter

1. Read [`../../README.md`](../../README.md)'s Settings and Supported mutations sections.
2. Capture one failing mutation, its destination path, startup warning, and formatter warning.
3. Resolve the effective Formatter Definition, then check its file selector, Activation Gate, root, working directory, and `$FILE` mode against that path.
4. Verify the executable and arguments with a safe check or an approved reproduction.
5. For a requested change, edit one settings layer, validate JSON, reload Pi, and repeat the same mutation.
6. Finish when the same destination formats or the exact selector, activation, root, spawn, timeout, or exit boundary is evidenced.

A formatter failure warns but does not fail the original mutation. A `Formatted by <id>[, <id>…]: …` line, with the unified diff that follows it, is normal output, not a failure; the `+` and ` ` lines are the file's current text. A line with no diff means the change was too large to show, so re-read the file before editing it. After parallel edits to one file, only one result normally carries the line: formatting holds Pi's file mutation queue, so each edit lands before or after it, and the first formatting covers every edit that landed before it. A formatter syntax error carries no pointer to this Skill; fix the file instead. If a syntax error still carries the pointer, or a configuration error lacks it, check the formatter's `syntaxErrorPattern` against its stderr.
