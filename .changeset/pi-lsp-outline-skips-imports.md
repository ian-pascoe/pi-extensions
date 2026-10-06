---
"@ian-pascoe/pi-lsp": minor
---

`lsp_document_symbols` no longer lists import bindings in its default outline, where they were up to half the lines of a file. When the server supports folding ranges, one extra request finds the `imports` range, and top-level symbols inside it are left out and counted in the final hint and the structured `omitted`. `depth: "all"` still lists them, and a server without folding ranges or an `imports` range, or a failed folding request, gives the same outline as before.
