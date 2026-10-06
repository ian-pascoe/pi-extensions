---
"@ian-pascoe/pi-lsp": patch
---

Post-edit Diagnostics no longer add a "not checked (no configured server)" line: files no Server Definition covers stay silent, and no diagnostics section is appended when none of the edited files is covered, while a failure or timeout from a covering Server Definition's Server Instance is still reported.
