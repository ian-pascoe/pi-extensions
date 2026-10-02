---
"@ian-pascoe/pi-advisor": minor
---

`advisor_ask` now declares MCP-style tool `annotations` (read-only, non-destructive, idempotent, closed-world), and the Advisor Session's internal `advisor_report` tool declares non-destructive, closed-world annotations, so permission extensions inherited by either session no longer fall back to the pessimistic defaults. Pi reports them through `pi.getAllTools()` and does not send them to model providers, so tool declarations, the system prompt, and the prompt cache prefix are unchanged.
