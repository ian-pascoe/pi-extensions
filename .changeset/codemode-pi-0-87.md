---
"@ian-pascoe/pi-codemode": patch
---

Support Pi 0.87.1 and `@howaboua/pi-codex-conversion` 3.0.37. Nested tool results no longer report `addedToolNames`, which Pi now derives from transcript tool deltas, and the known `exec_command` and `write_stdin` output schemas accept the new `truncated` flag.
