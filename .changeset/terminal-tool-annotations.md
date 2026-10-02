---
"@ian-pascoe/pi-termctrl": minor
---

The Terminal tools now declare MCP-style tool `annotations`, reported through `pi.getAllTools()` for permission extensions. `terminal_start` and `terminal_send` run arbitrary programs, so they are destructive and open-world and not idempotent. `terminal_stop` is destructive and idempotent. `terminal_list` and `terminal_wait` are read-only and closed-world. The `bash` replacement keeps the annotations of Pi's built-in `bash`, which declares none. Annotations are not sent to model providers, so tool declarations, the system prompt, and the prompt cache prefix are unchanged, with and without built-in `codemode`.
