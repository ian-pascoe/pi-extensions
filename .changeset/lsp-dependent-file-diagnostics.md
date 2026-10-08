---
"@ian-pascoe/pi-lsp": minor
---

Report the new errors a native `edit` or `write` causes in dependent files under a separate "LSP diagnostics in dependent files" heading. Dependents are found with `textDocument/references` for the touched declarations (so pull-only servers such as `tsc --lsp` work), capped at 20 files and error severity, with the number of unchecked files reported.
