---
"@ian-pascoe/pi-lsp": minor
---

`lsp_workspace_diagnostics` no longer requires `server_id`. Without it, the tool queries every matching server for `file_path`, as the other reads do, and groups the results by server. A server that publishes no workspace diagnostics still reports `status: "unsupported"`, and a failing server appears in `warnings` without hiding the others. An explicit `server_id` limits the request to that server, as before. `lsp_capabilities` and `lsp_restart` still require `server_id`.
