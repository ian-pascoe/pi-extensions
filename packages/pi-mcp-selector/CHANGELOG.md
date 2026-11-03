# @ian-pascoe/pi-mcp-selector

## 0.2.1

### Patch Changes

- Updated dependencies [1a9d7cc]
  - @ian-pascoe/pi-utils@0.13.0

## 0.2.0

### Minor Changes

- fda04cb: **Breaking:** reference MCP servers with `&server` instead of `@server`. `&github` becomes `[&github](mcp://github "MCP server mcp__github")` on submission, and `&` opens its own popup, including a lone `&` at the start of a line. `@` is no longer used, because `@ff-labs/pi-fff` answers `@` itself and hid servers from a shared popup; the popup no longer merges file results. HTML entities such as `&amp;` stay literal even when a server has that name. If an extension wraps Pi's autocomplete provider without forwarding `triggerCharacters`, press Tab after `&` to open the popup. Also fixes server descriptions that began with a Markdown heading marker (`# Executor` now reads `Executor`).

## 0.1.0

### Minor Changes

- 31473aa: Add Pi MCP Selector: type `@` to list your MCP servers above Pi's native file results, and a reference such as `@github` becomes `[@github](mcp://github "MCP server mcp__github")` on submission. A reference only points the model at the server; it loads, connects, and exposes nothing, so the cached prompt prefix is unchanged. The catalogue is every enabled, connected server with a tool that is not hidden. Unknown, partial, path-like, and code references stay literal.

### Patch Changes

- Updated dependencies [d3041cf]
- Updated dependencies [2552e08]
  - @ian-pascoe/pi-utils@0.12.0
