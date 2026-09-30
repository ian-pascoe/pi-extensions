---
"@ian-pascoe/pi-lsp": patch
"@ian-pascoe/pi-dap": patch
---

Stop declaring an output schema that describes only display details. Pi's built-in `codemode` returns structured results for tools with an output schema, which would hide raw results from scripts; scripts now receive the complete text result as declared.
