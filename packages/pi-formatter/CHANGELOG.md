# @ian-pascoe/pi-formatter

## 0.3.0

### Minor Changes

- 1c6bc03: Requires Pi 0.99.0 or later. Format files changed by `lsp_apply`, the Pi LSP tool that replaces the single `lsp` tool's apply operation. Results of the `lsp` tool are still recognized. Formatter warnings appended to a tool result no longer drop that result's structured content, which `codemode` scripts receive.

### Patch Changes

- 0ea1e75: Declare Pi `>=0.99.0` as the peer range for `@earendil-works/pi-coding-agent`, `pi-ai`, `pi-agent-core`, and `pi-tui`, replacing `*`. Installing against an older Pi now warns at install time instead of failing when a package uses an API that Pi release lacks. Pi Utils keeps its Pi peer optional.

## 0.2.1

### Patch Changes

- 2daa891: Bundled troubleshooting Skills no longer appear in the model's system prompt. Each now sets `disable-model-invocation: true`, so installing the package adds no per-turn context and you no longer need `skills` package filters to hide them. To open one, use `/skill:<package>` or a `$<package>` Skill Reference. Packages whose failures the model can see append that package's Skill path to configuration and runtime failures, so the model loads the guide only when one occurs.

## 0.2.0

### Minor Changes

- 706d063: Add package skills that guide Pi through extension configuration and diagnosis.
