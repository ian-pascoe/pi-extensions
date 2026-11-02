---
"@ian-pascoe/pi-mcp-selector": minor
---

Add Pi MCP Selector: type `@` to list your MCP servers above Pi's native file results, and a reference such as `@github` becomes `[@github](mcp://github "MCP server mcp__github")` on submission. A reference only points the model at the server; it loads, connects, and exposes nothing, so the cached prompt prefix is unchanged. The catalogue is every enabled, connected server with a tool that is not hidden. Unknown, partial, path-like, and code references stay literal.
