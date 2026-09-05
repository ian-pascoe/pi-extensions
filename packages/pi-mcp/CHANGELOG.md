# @ian-pascoe/pi-mcp

## 0.5.0

### Minor Changes

- 290d6dc: Retain matching MCP clients and validated catalogs across in-process Pi session replacement, while deferring and batching cold-start work to keep TUI input responsive.

### Patch Changes

- b05e6ab: Defer MCP schema compilation until use, stop MCP startup from delaying the first prompt, and avoid rebuilding the CodeMode catalogue after every dynamic tool registration.
- 13f666c: Wait for timed-out stdio MCP Servers to exit before reporting connection failure.

## 0.4.3

### Patch Changes

- 195507b: Reduce MCP catalog startup work and keep JSON Schema warnings out of Pi's TUI.

## 0.4.2

### Patch Changes

- 6bfd482: Keep terminal input responsive while MCP Server Tool catalogs compile and register.

## 0.4.1

### Patch Changes

- eff9c6a: Prevent harmless unknown JSON Schema format warnings from flooding Pi's TUI.
- 291a3d2: Reduce duplicate TUI footer status and use compact Nerd Font-aware MCP and throughput indicators.
- Updated dependencies [291a3d2]
  - @ian-pascoe/pi-utils@0.1.1

## 0.4.0

### Minor Changes

- 841a7df: Add bounded CodeMode tool discovery and typed tool result schemas across supporting extensions.

## 0.3.2

### Patch Changes

- ec033d7: Restore OAuth discovery for MCP server URLs that include query parameters.

## 0.3.1

### Patch Changes

- 4e356a8: Bump dependencies

## 0.3.0

### Minor Changes

- 706d063: Add package skills that guide Pi through extension configuration and diagnosis.

## 0.2.0

### Minor Changes

- 023f5e9: Add semantic MCP transcript rendering, TUI health and attention status, richer read-only commands, full `/mcp` argument completion, and remove the `/mcp logs --level` side effect.
