---
"@ian-pascoe/pi-context-management": patch
---

Read Lineage sessions without blocking Pi, and skip a session file that is deleted or unreadable mid-scan instead of failing the `context_notes` or `context_history` call. A Notes `read` with neither `name` nor `ref` now reports that one is required before looking anything up.
