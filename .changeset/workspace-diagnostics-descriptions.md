---
"@ian-pascoe/pi-lsp": patch
---

The `lsp_workspace_diagnostics` description no longer repeats the shared `server_id` narrowing rule, and the root-anchor `file_path` parameter now says it selects the matching servers and their roots, since `lsp_workspace_diagnostics` and `lsp_workspace_symbols` can query several servers.
