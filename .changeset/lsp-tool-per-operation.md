---
"@ian-pascoe/pi-lsp": minor
---

**Breaking:** requires Pi 0.99.0 or later. The single `lsp` tool is replaced by one tool per operation, named `lsp_<operation>` (for example `lsp_hover` and `lsp_apply`) and grouped under the `lsp` namespace. Each tool takes only its own arguments, so `{"operation":"hover", ...}` becomes `lsp_hover` with the same fields minus `operation`. There is no alias for `lsp`.

Ten tools are declared to the model: `lsp_status`, `lsp_diagnostics`, `lsp_hover`, `lsp_goto_definition`, `lsp_find_references`, `lsp_document_symbols`, `lsp_workspace_symbols`, `lsp_rename`, `lsp_code_actions`, and `lsp_apply`. The other operations, including `lsp_capabilities`, `lsp_restart`, and formatting, are callable from Pi's `codemode` scripts, which list them under the `lsp` namespace, and `tool_search` can load them. Both are off by default; without them, add a tool by name with `defaultTools` (for example `"+lsp_capabilities"`) or `--tools`.

Migration:

- Settings that grant or select `lsp` by exact name (`defaultTools`, `--tools`, Advisor `allowedTools`, Minimal Subagents toolsets) must name the new tools, for example the pattern `lsp_*` in a Minimal Subagents toolset.
- `lsp_status` now reports `server_id` and `root_path` instead of `serverId` and `rootPath`.
- Resumed sessions keep their Workspace Edit Previews from `lsp` results; apply them with `lsp_apply`.

Each tool carries tool annotations for permission extensions: queries and preview tools are read-only (preview tools are not idempotent, since each call creates a new `preview_id`), `lsp_restart` is non-destructive, and `lsp_apply` is destructive. Every tool also declares an output schema, so `codemode` scripts receive structured results. A structured result is capped at 1 MiB, like Pi's built-in `bash` tool: a larger one is bounded (the longest strings and array tails are cut, and ids, paths, and enum values are kept) and reports `structured_truncated: true` and `truncated: true`, with `spill_path` naming a Result Spill that holds the complete structured data. `truncated` and `spill_path` are also set when only the model-visible text was cut; `structured_truncated` then stays `false`. `lsp_diagnostics` has a prompt snippet so the `lsp_*` tools appear in Pi's default system prompt. An `lsp_apply` partial failure is now an error result from the tool itself, and scripts still receive its structured result.
