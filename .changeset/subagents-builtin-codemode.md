---
"@ian-pascoe/pi-minimal-subagents": minor
---

Support Pi's built-in `codemode`, `tool_search`, and MCP in Child Agents. Children load the built-in extensions the root has enabled, an omitted tool selection inherits the caller's Reachable Tools (including `codemode`- and `deferred`-exposed tools such as MCP tools), granted script-only tools stay undeclared, and coordinator tools return `structuredContent` so scripts receive objects. Closing a child runtime now emits `session_shutdown` so child extensions release services such as MCP server connections.
