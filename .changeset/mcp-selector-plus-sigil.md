---
"@ian-pascoe/pi-mcp-selector": minor
---

**Breaking:** reference MCP servers with `+server` instead of `@server`. `+github` becomes `[+github](mcp://github "MCP server mcp__github")` on submission, and `+` opens its own popup. `@` is no longer used, because `@ff-labs/pi-fff` answers `@` itself and hid servers from a shared popup; the popup no longer merges file results. If an extension wraps Pi's autocomplete provider without forwarding `triggerCharacters`, press Tab after `+` to open the popup. Also fixes server descriptions that began with a Markdown heading marker (`# Executor` now reads `Executor`).
