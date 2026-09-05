# @ian-pascoe/pi-codemode

## 0.6.5

### Patch Changes

- 9b5c7c2: Update dependencies

## 0.6.4

### Patch Changes

- b05e6ab: Defer MCP schema compilation until use, stop MCP startup from delaying the first prompt, and avoid rebuilding the CodeMode catalogue after every dynamic tool registration.
- 8e665f5: Preserve custom fixed-name tool rendering when Pi reloads extensions.

## 0.6.3

### Patch Changes

- 229ea22: Expose tools registered after CodeMode starts, including tools loaded by Pi MCP, without widening Child Agent Launch Contracts.

## 0.6.2

### Patch Changes

- 291a3d2: Reduce duplicate TUI footer status and use compact Nerd Font-aware MCP and throughput indicators.

## 0.6.1

### Patch Changes

- 5cdd3b5: Update dependencies

## 0.6.0

### Minor Changes

- fb76c3f: Keep empty and fuzzy `codemode_search` results compact, and return complete TypeScript declarations only for exact-name queries.
- df0f6f7: Allow `codemode_execute` to create a session under an unknown supplied Session ID, and prevent Exposure Mode rules from reactivating tools disabled by Pi or another extension.

## 0.5.0

### Minor Changes

- 841a7df: Add bounded CodeMode tool discovery and typed tool result schemas across supporting extensions.

## 0.4.1

### Patch Changes

- 4e356a8: Bump dependencies

## 0.4.0

### Minor Changes

- 706d063: Add package skills that guide Pi through extension configuration and diagnosis.

## 0.3.1

### Patch Changes

- 980de19: Truncate collapsed CodeMode Transcript source lines instead of wrapping them.

## 0.3.0

### Minor Changes

- 486e673: Capture supported Deno Console calls in terminal CodeMode Cell results and Transcript rendering.

## 0.2.0

### Minor Changes

- 849c395: Reclaim least-recently-used idle sessions under capacity pressure and add a read-only live-session listing tool.

## 0.1.0

Initial release.
