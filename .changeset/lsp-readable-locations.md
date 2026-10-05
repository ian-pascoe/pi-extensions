---
"@ian-pascoe/pi-lsp": minor
---

Location results read as compact text. `lsp_find_references`, the goto tools, `lsp_declaration`, and `lsp_document_highlights` now show the model one `path:line:col  <source line>` line per location, with paths relative to the working directory and named highlight kinds (`read`, `write`, `text`). Results are grouped by server only when several servers answered. Structured Results for codemode scripts are unchanged, and the tool guidance states that result positions are one-based.
