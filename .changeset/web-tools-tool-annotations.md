---
"@ian-pascoe/pi-web-tools": minor
---

`web_search` and `web_fetch` now declare MCP-style tool `annotations`: read-only, non-destructive, idempotent, and open-world. Pi reports them through `pi.getAllTools()`, so permission extensions no longer fall back to the pessimistic defaults for a tool that is not read-only, may be destructive, and may reach an open world. Annotations are not sent to model providers, so tool declarations, the system prompt, and the prompt cache prefix are unchanged.
