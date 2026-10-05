---
"@ian-pascoe/pi-lsp": minor
---

`lsp_completion` and `lsp_workspace_symbols` return a bounded, relevant list. Both accept `limit` (default 50 items per server) and report how many more items matched. `lsp_completion` accepts `prefix`, which defaults to the identifier before the position, and orders matches by the server's sort text. Only kept items are resolved. The model sees one `label (kind)  detail` line per completion, matching the `name (kind)` symbol format, without server-private resolve `data`. Workspace symbols keep the shared symbol format and gain the omitted count. Structured Results hold the bounded response plus `prefix` and `omitted`.
