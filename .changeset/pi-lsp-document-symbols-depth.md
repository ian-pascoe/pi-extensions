---
"@ian-pascoe/pi-lsp": minor
---

`lsp_document_symbols` now lists a file as an outline by default: top-level declarations plus the members of classes, interfaces, enums, namespaces, modules, and structs, without the locals, return-object properties, and callbacks inside function, method, and variable bodies. The new optional `depth` parameter adds one level inside those bodies per step, and `depth: "all"` returns the full tree as before. The structured result follows the requested depth.
