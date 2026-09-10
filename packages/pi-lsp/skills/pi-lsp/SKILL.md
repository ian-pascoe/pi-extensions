---
name: pi-lsp
description: Configure or diagnose Pi LSP when a server fails, a file does not route, diagnostics are missing, or managed installation, cancellation, update, or lsp settings need attention.
license: MIT
---

# Pi LSP

1. Read [`../../README.md`](../../README.md)'s preset, Managed installations, Settings, and `/lsp` command sections. Identify the effective settings scope and whether the server is an Explicit Definition or Language Tool Preset.
2. Call `lsp` with `{"operation":"status"}`. If the Server Definition is disabled, report that state and its enablement controls before attempting startup.
3. Check whether a representative request would acquire tools: `lsp.autoInstall` defaults to true; false permits existing installations only. Status never acquires anything. With first-use acquisition authorized, test `capabilities`, then `diagnostics`, supplying `server_id` when needed.
4. Classify the result as settings, routing, acquisition, process, capability, or Post-edit Diagnostics behavior. Explicit matching definitions suppress all fallbacks even under other IDs; disabled, null, and quarantined definitions do not authorize replacement. TypeScript 6 `tsc` is not the TypeScript 7 native LSP.
5. If Server Definitions changed, reload Pi. Enablement commands apply immediately. For an unavailable Server Instance, use the `restart` tool operation only when recovery is authorized.
6. Repeat status, capabilities, and diagnostics. Finish when the representative file reaches the intended Server Instance and operation, or an exact unsupported capability is evidenced.

For an authorized Tool Update, `/lsp update [preset-id]` changes only existing Managed Installations and reports old/new or no-change versions. Installed-only Mode does not block explicit updates. Escape cancels the TUI loader; RPC clients use `/lsp update cancel` rather than idle RPC `abort`. Failed/cancelled updates retain the old selection, and running Instances stay on their original executable until restarted. Consult the README's installer link when integrity, platform baselines, or private-store isolation is implicated.

`configured` has not routed a file yet; `stopped` permits lazy startup; `disabled` blocks startup. `unavailable` is sticky and retains stderr. Keep diagnosis read-only until a lifecycle change is authorized; stop before applying a Workspace Edit Preview.
