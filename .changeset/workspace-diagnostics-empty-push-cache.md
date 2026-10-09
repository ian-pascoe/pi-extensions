---
"@ian-pascoe/pi-lsp": patch
---

`lsp_workspace_diagnostics` reports `unsupported` for a server that answers only document pulls whenever its push cache covers no open file, instead of an empty `fresh` result that read as a clean workspace.
