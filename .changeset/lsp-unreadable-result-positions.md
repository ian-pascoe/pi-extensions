---
"@ian-pascoe/pi-lsp": patch
---

LSP results no longer convert a position against the wrong file's text. Before, a result naming a file without readable text, such as a `jdt://` or `deno:` URI, a file that failed to read, or invalid UTF-8, could fail that server's whole result with a position error or show wrong columns.

Positions in such a file are now approximated by adding 1 to the line and character, and a warning names the file: lines are exact, but columns may be off after non-ASCII text. This covers `lsp_goto_definition` and the other location tools, `lsp_incoming_calls`, `lsp_outgoing_calls`, `lsp_workspace_symbols`, and `lsp_workspace_diagnostics`.

`lsp_outgoing_calls` now shows call sites in a non-`file:` calling item under its URI instead of under the queried file, and `lsp_workspace_symbols` lists symbols in such files as symbol lines instead of JSON. Positions in the queried file use the text the server was synced with.
