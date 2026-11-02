---
"@ian-pascoe/pi-mcp-selector": minor
---

**Breaking:** reference MCP servers with `&server` instead of `@server`. `&github` becomes `[&github](mcp://github "MCP server mcp__github")` on submission, and `&` opens its own popup, including a lone `&` at the start of a line. `@` is no longer used, because `@ff-labs/pi-fff` answers `@` itself and hid servers from a shared popup; the popup no longer merges file results. HTML entities such as `&amp;` stay literal even when a server has that name. If an extension wraps Pi's autocomplete provider without forwarding `triggerCharacters`, press Tab after `&` to open the popup. Also fixes server descriptions that began with a Markdown heading marker (`# Executor` now reads `Executor`).
