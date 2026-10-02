---
"@ian-pascoe/pi-context-management": minor
---

`context_history`, `context_notes`, and `context_rollover` now declare MCP-style tool `annotations`, all closed-world. `context_history` is read-only; `context_notes` and `context_rollover` are not read-only but are non-destructive and not idempotent, because they append to the session journal and earlier values stay readable through History. Pi reports the hints through `pi.getAllTools()` for permission extensions. Annotations are not sent to model providers, so tool declarations, the system prompt, and the prompt cache prefix are unchanged.
