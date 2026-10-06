---
"@ian-pascoe/pi-lsp": patch
---

Report a diagnostics wait that ends in silence as `no diagnostics published by <server> within <wait>` (not a failure) instead of a bare `diagnostics timeout`, and remember that silence per document version for servers with no document pull so a repeat `lsp_diagnostics` of an unchanged file answers at once. A push, edit, close, or server restart forgets it (#333).
