# @ian-pascoe/pi-tps-tracker

## 0.4.0

### Minor Changes

- 4ef1998: The TPS footer status and end-of-run notification are plain text in the shared footer-status layout, and Nerd Font icon handling is removed. Requires Pi 1.1.0 or newer.

### Patch Changes

- Updated dependencies [4ef1998]
- Updated dependencies [4ef1998]
  - @ian-pascoe/pi-utils@0.5.0

## 0.3.1

### Patch Changes

- Updated dependencies [ac8fb7a]
- Updated dependencies [9b5cae5]
  - @ian-pascoe/pi-utils@0.4.0

## 0.3.0

### Minor Changes

- 0ea1e75: These packages now require Pi `>=0.99.0`, raised from an undeclared (`*`) peer range and a documented floor of `0.84.1` or `0.85.1`. Pi 0.99.0 is the first release that provides the tool exposure, output schema, and built-in extension APIs the repository uses, so the packages no longer carry fallbacks for older hosts.

  Advisor no longer probes the Pi SDK for missing exports and methods at load. It no longer pauses with "this Pi runtime lacks ..." diagnostics, because the peer range guarantees those members. Minimal Subagents always gives Child Agents Pi's built-in `codemode`, `tool-search`, and `mcp` extensions instead of skipping any the host lacked. Termctrl's `bash` replacement now requires Pi's `bash` to declare an object `outputSchema`, which Pi provides from 0.99.0, instead of silently falling back to an empty schema.

### Patch Changes

- Updated dependencies [0ea1e75]
  - @ian-pascoe/pi-utils@0.3.1

## 0.2.4

### Patch Changes

- 2daa891: Bundled troubleshooting Skills no longer appear in the model's system prompt. Each now sets `disable-model-invocation: true`, so installing the package adds no per-turn context and you no longer need `skills` package filters to hide them. To open one, use `/skill:<package>` or a `$<package>` Skill Reference. Packages whose failures the model can see append that package's Skill path to configuration and runtime failures, so the model loads the guide only when one occurs.

## 0.2.3

### Patch Changes

- Updated dependencies [be50c8c]
- Updated dependencies [be50c8c]
  - @ian-pascoe/pi-utils@0.3.0

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
