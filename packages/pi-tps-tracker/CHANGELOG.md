# @ian-pascoe/pi-tps-tracker

## 0.2.2

### Patch Changes

- f27ee9e: Add Pi Advisor review sessions, scoped configuration, safe intervention scheduling, and Minimal Subagents integration. Share native AgentSession discovery through `pi-utils`; refactor CodeMode to use the shared capture helper. Resolve discovery against the running host's SDK class, including bundled CLI startup and reload, rather than a compiled dependency's separate SDK instance. Add native Advisor argument autocomplete for commands, settings keys, and scope flags. Recreate Pi 0.85.1's built-in inline llama.cpp extension from its shipped file so actual CLI reviews settle before and after reload, while unsupported inline resources still fail closed. Recognize both verified native auth-storage class names in Pi's bundled CLI and SDK so file-backed OAuth keeps native refresh and locking rather than being misclassified as custom storage.

## 0.2.1

### Patch Changes

- 291a3d2: Reduce duplicate TUI footer status and use compact Nerd Font-aware MCP and throughput indicators.
- Updated dependencies [291a3d2]
  - @ian-pascoe/pi-utils@0.1.1

## 0.2.0

### Minor Changes

- 706d063: Add package skills that guide Pi through extension configuration and diagnosis.

## 0.1.1

### Patch Changes

- 00e8819: Refactor AI overengineering
