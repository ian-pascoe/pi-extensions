---
"@ian-pascoe/pi-lsp": patch
---

Post-edit Diagnostics no longer add a "not checked (no configured server)" line: files no language server covers stay silent, and nothing is appended when no edited file has a server, while a matched server's failure or timeout is still reported.
