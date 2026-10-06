---
"@ian-pascoe/pi-lsp": minor
---

`lsp_diagnostics`, `lsp_workspace_diagnostics`, `lsp_hover`, `lsp_status`, `lsp_code_actions`, and `lsp_apply` now show the model compact text (such as one `path:line:col severity source(code): message` line per diagnostic) instead of a JSON envelope, while scripts still receive the unchanged structured result.
