---
name: pi-lsp
description: Configure or diagnose Pi LSP when a Server Definition fails, a file does not route, diagnostics are missing, or lsp settings need changing.
license: MIT
---

# Pi LSP

1. Read [`../../README.md`](../../README.md)'s Settings and `lsp` tool sections, then identify the effective settings scope.
2. Call `lsp` with `{"operation":"status"}`.
3. Test a representative file with `capabilities`, then `diagnostics`, supplying `server_id` when needed.
4. Classify the result as settings, routing, process, capability, or Post-edit Diagnostics behavior.
5. If settings changed, reload Pi; if settings are unchanged and the Server Instance is unavailable, use `restart`.
6. Repeat status, capabilities, and diagnostics. Finish when the representative file reaches the intended Server Instance and operation, or an exact unsupported capability is evidenced.

`configured` has not routed a file yet. `unavailable` is sticky and retains stderr. Keep diagnosis read-only; stop before applying a Workspace Edit Preview.
