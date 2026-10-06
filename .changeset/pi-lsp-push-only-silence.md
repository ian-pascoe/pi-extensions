---
"@ian-pascoe/pi-lsp": patch
---

Report a diagnostics wait that ends in silence as `no diagnostics published by <server> within <wait>` (not a failure) instead of a bare `diagnostics timeout`, and remember that silence per document version for push-only servers so a repeat `lsp_diagnostics` of an unchanged file answers at once. A push, edit, close, or Server Instance restart forgets it. A file whose current version the server already published diagnostics for now returns them instead of timing out. A pull-capable server that times out reads as a stalled request (`no diagnostics received from <server>`) rather than as a clean file.
