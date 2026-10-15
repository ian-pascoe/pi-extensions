---
"@ian-pascoe/pi-minimal-subagents": patch
---

Child Agents reach only the MCP tools their Launch Contract grants: `codemode` and `tool_search` no longer find or call ungranted MCP tools. A child loads Pi's `mcp` extension only when it is granted an MCP tool, and then connects only the `mcp.json` servers those tools reach, so children no longer start their own copy of every stdio MCP server.
