# Share `@` with file mentions

> **Superseded by [ADR-0002](0002-plus-sigil.md).** MCP Server References now use `+` and no longer share the `@` popup.

MCP Server References use `@`, the sigil users already know from other agents, even though Pi's native autocomplete uses `@` for file paths. The two share one popup: matching servers are listed first, then the native file results. On submission an exact MCP Server Catalogue name followed by a boundary converts, and anything shaped like a path (`@name/`, `@name.ext`, `@./name`) stays literal. A native file item whose text equals a server name is inserted as `@./name`, so selecting a file never produces a server reference. Pi does not expand `@path` in submitted messages, so only the popup and the literal text are shared.

## Considered Options

- `+name` would avoid the overlap, but users don't recognise it, and diffs pasted without code fences and Pi's `+tool` settings syntax written in prose would collide with it.
- `@mcp:name` and `@@name` are unambiguous but clumsy to type, and neither matches what users expect from other agents.
