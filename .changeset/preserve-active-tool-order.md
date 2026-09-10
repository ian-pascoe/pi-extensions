---
"@ian-pascoe/pi-mcp": patch
"@ian-pascoe/pi-minimal-subagents": patch
---

Preserve existing active-tool order during MCP catalogue refreshes and Subagent Access reconciliation to avoid unnecessary prompt-cache invalidation. Append only newly active tools while retaining capability removal and Coordinator Tool deduplication.
