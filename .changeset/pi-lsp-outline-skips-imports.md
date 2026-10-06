---
"@ian-pascoe/pi-lsp": minor
---

`lsp_document_symbols` no longer lists import bindings in its default outline, where they were up to half the lines of a file. When the server supports folding ranges, one extra request finds the `imports` range, and top-level symbols inside it are left out. A separate closing line counts them (`N import bindings omitted; pass depth: "all" to see them.`), and the structured result adds `omitted_imports` to the `omitted` count. `depth: "all"` still lists them, and a server without folding ranges or an `imports` range, or a failed folding request, gives the same outline as before. Cancelling the call still cancels it.
