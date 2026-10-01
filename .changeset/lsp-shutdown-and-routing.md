---
"@ian-pascoe/pi-lsp": patch
---

Shutting down a language server no longer fails when its connection closed before its process exited. Post-edit diagnostics and other file routing no longer list every ancestor directory for files no configured server handles, which made large batches of edits slow in big directories.
