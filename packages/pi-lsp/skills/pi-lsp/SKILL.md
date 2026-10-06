---
name: pi-lsp
description: Configure or diagnose Pi LSP when a Server Definition fails, a file does not route, diagnostics are missing, or lsp settings need changing.
license: MIT
disable-model-invocation: true
---

# Pi LSP

1. Read [`../../README.md`](../../README.md)'s Settings, `/lsp` command, and LSP tools sections, then identify the effective settings scope.
2. Call `lsp_status` with `all: true`, because the default text lists only Server Instances (running, starting, unavailable, stopped) and disabled Server Definitions, and counts the rest. Check that the representative file's extension or filename appears in the Server Definition's `languages`. If the Server Definition is disabled, report that state and its enablement controls before attempting startup.
3. Test a representative file with `lsp_capabilities`, then `lsp_diagnostics`, supplying `server_id` when needed.
4. Classify the result as settings, routing, process, capability, or Post-edit Diagnostics behavior.
5. If Server Definitions changed, reload Pi. Enablement commands apply immediately. For an unavailable Server Instance, use `lsp_restart` only when recovery is authorized; otherwise ask the user to run `/lsp stop <server-id> <root>`, which permits a fresh lazy start.
6. Repeat status, capabilities, and diagnostics. Finish when the representative file reaches the intended Server Instance and operation, or an exact unsupported capability is evidenced.

`lsp_status` is declared to the model. `lsp_capabilities` and `lsp_restart` are not declared by default. Call them from a `codemode` script (`await tools.lsp_capabilities({...})`) or load them with `tool_search`. If neither tool is active, ask the user to add the tools to `defaultTools` (for example `"+lsp_capabilities"`); the user can also run `/lsp` for status or `/lsp stop <server-id> <root>` to recover a server.

`configured` has not routed a file yet; `stopped` permits lazy startup; `disabled` blocks startup. `unavailable` is sticky and retains stderr. Keep diagnosis read-only until a lifecycle change is authorized; stop before applying a Workspace Edit Preview.
