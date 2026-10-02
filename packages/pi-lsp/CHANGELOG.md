# @ian-pascoe/pi-lsp

## 0.5.0

### Minor Changes

- 1c6bc03: **Breaking:** requires Pi 0.99.0 or later. The single `lsp` tool is replaced by one tool per operation, named `lsp_<operation>` (for example `lsp_hover` and `lsp_apply`) and grouped under the `lsp` namespace. Each tool takes only its own arguments, so `{"operation":"hover", ...}` becomes `lsp_hover` with the same fields minus `operation`. There is no alias for `lsp`.

  Ten tools are declared to the model: `lsp_status`, `lsp_diagnostics`, `lsp_hover`, `lsp_goto_definition`, `lsp_find_references`, `lsp_document_symbols`, `lsp_workspace_symbols`, `lsp_rename`, `lsp_code_actions`, and `lsp_apply`. The other operations, including `lsp_capabilities`, `lsp_restart`, and formatting, are callable from Pi's `codemode` scripts, which list them under the `lsp` namespace, and `tool_search` can load them. Both are off by default; without them, add a tool by name with `defaultTools` (for example `"+lsp_capabilities"`) or `--tools`.

  Migration:

  - Settings that grant or select `lsp` by exact name (`defaultTools`, `--tools`, Advisor `allowedTools`, Minimal Subagents toolsets) must name the new tools, for example the pattern `lsp_*` in a Minimal Subagents toolset.
  - `lsp_status` now reports `server_id` and `root_path` instead of `serverId` and `rootPath`.
  - Resumed sessions keep their Workspace Edit Previews from `lsp` results; apply them with `lsp_apply`.

  Each tool carries tool annotations for permission extensions: queries and preview tools are read-only (preview tools are not idempotent, since each call creates a new `preview_id`), `lsp_restart` is non-destructive, and `lsp_apply` is destructive. Every tool also declares an output schema, so `codemode` scripts receive structured results. A structured result is capped at 1 MiB, like Pi's built-in `bash` tool: a larger one is bounded (the longest strings and array tails are cut, and ids, paths, and enum values are kept) and reports `structured_truncated: true` and `truncated: true`, with `spill_path` naming a Result Spill that holds the complete structured data. `truncated` and `spill_path` are also set when only the model-visible text was cut; `structured_truncated` then stays `false`. `lsp_diagnostics` has a prompt snippet so the `lsp_*` tools appear in Pi's default system prompt. An `lsp_apply` partial failure is now an error result from the tool itself, and scripts still receive its structured result.

### Patch Changes

- 0ea1e75: Declare Pi `>=0.99.0` as the peer range for `@earendil-works/pi-coding-agent`, `pi-ai`, `pi-agent-core`, and `pi-tui`, replacing `*`. Installing against an older Pi now warns at install time instead of failing when a package uses an API that Pi release lacks. Pi Utils keeps its Pi peer optional.
- Updated dependencies [0ea1e75]
  - @ian-pascoe/pi-utils@0.3.1

## 0.4.7

### Patch Changes

- b15f4fd: Shutting down a language server no longer fails when its connection closed before its process exited. Post-edit diagnostics and other file routing no longer list every ancestor directory for files no configured server handles, which made large batches of edits slow in big directories.

## 0.4.6

### Patch Changes

- 2daa891: Bundled troubleshooting Skills no longer appear in the model's system prompt. Each now sets `disable-model-invocation: true`, so installing the package adds no per-turn context and you no longer need `skills` package filters to hide them. To open one, use `/skill:<package>` or a `$<package>` Skill Reference. Packages whose failures the model can see append that package's Skill path to configuration and runtime failures, so the model loads the guide only when one occurs.

## 0.4.5

### Patch Changes

- 1a7c706: Stop declaring an output schema that describes only display details. Pi's built-in `codemode` returns structured results for tools with an output schema, which would hide raw results from scripts; scripts now receive the complete text result as declared.
- be50c8c: Add `updateFileLocked` (`@ian-pascoe/pi-utils/locked-file-update`), which atomically updates a file under Pi's native settings lock. LSP and Minimal Subagents settings commands now share it.
- Updated dependencies [be50c8c]
- Updated dependencies [be50c8c]
  - @ian-pascoe/pi-utils@0.3.0

## 0.4.4

### Patch Changes

- 8af327e: Show up to eight rendered rows of Post-edit Diagnostics in the collapsed transcript entry while keeping the expanded entry complete.

## 0.4.3

### Patch Changes

- 7b5b785: Fix LSP and DAP startup with `pi --no-session` by using a private OS temporary directory when Pi supplies an empty session directory. Result Spills and stderr files retain their existing permissions and normal teardown cleanup.

## 0.4.2

### Patch Changes

- 981f655: Register the `lsp` tool with an object-shaped parameter schema so providers that validate tool schemas strictly accept requests.

  The tool's parameters were a `Type.Union([...])` of 35 per-operation branches. A top-level union
  serialises to `anyOf` with no `type`, and DeepSeek rejects every request while such a tool is
  registered:

  ```
  400 invalid_request_error: Invalid schema for function 'lsp':
  schema must be a JSON Schema of 'type: "object"', got 'type: null'.
  ```

  Because the tool is registered in every request this failed turns that never used the tool at all,
  so the package made Pi unusable on that provider.

  Wrapping the union (for example `{ type: "object", anyOf: [...] }`) is not an option: Pi's
  constrained-sampling helper rejects object and array unions and requires a root schema of
  `type: "object"`, so the registered schema has to be a plain object.

  `LspToolParametersSchema` is unchanged and still the strict per-operation validator applied at the
  tool ingress, so an incomplete or contradictory argument set is still rejected with the existing
  `Pi LSP: invalid tool arguments` failure. A new `LspToolProviderParametersSchema` — a flat object
  whose fields reuse the same per-field schemas — is what Pi now registers and what the model sees. A
  contract test asserts the registered schema is an object and pins it to the validation branches:
  every operation the branches use must be accepted, the two field sets must be equal, and each field
  must reuse the branch schema verbatim, so the two cannot drift.

  The tool description lists the required fields for every operation, derived from the strict
  branches, so models retain argument guidance without reintroducing a top-level union.

## 0.4.1

### Patch Changes

- 1a2e2b9: Remove lint workarounds from package code

## 0.4.0

### Minor Changes

- cbe44d2: Add `/lsp` status and action pickers with stop, enable, and disable shortcuts. Preserve branch-local session enablement across reloads and resumes, support project/global overrides, and safely retire stopped or disabled server processes before lazy startup.

## 0.3.2

### Patch Changes

- 8e665f5: Preserve custom fixed-name tool rendering when Pi reloads extensions.

## 0.3.1

### Patch Changes

- 5cdd3b5: Update dependencies

## 0.3.0

### Minor Changes

- 841a7df: Add bounded CodeMode tool discovery and typed tool result schemas across supporting extensions.

## 0.2.1

### Patch Changes

- 4e356a8: Bump dependencies

## 0.2.0

### Minor Changes

- 706d063: Add package skills that guide Pi through extension configuration and diagnosis.

## 0.1.1

### Patch Changes

- 36785a2: Quarantine invalid server definitions and timeout fields without disabling unrelated valid LSP settings. Exclude formatting-only servers from Post-edit Diagnostics.
