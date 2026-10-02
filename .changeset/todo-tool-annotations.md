---
"@ian-pascoe/pi-todo": minor
---

The `todo` tool now declares MCP-style tool `annotations`: not read-only, non-destructive (it only appends to the session's own journal), not idempotent, and closed-world. Pi reports them through `pi.getAllTools()`, so permission extensions can tell that it never touches the environment beyond the session. Annotations are not sent to model providers, so tool declarations, the system prompt, and the prompt cache prefix are unchanged.
