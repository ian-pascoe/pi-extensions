---
"@ian-pascoe/pi-lsp": minor
---

`lsp_document_symbols` now lists a file as an outline by default: top-level declarations plus the members of classes, interfaces, enums, namespaces, modules, packages, objects, and structs, without the locals, return-object properties, and callbacks inside function, method, and variable bodies. The new optional `depth` parameter adds one level inside those bodies per step, and `depth: "all"` returns the full tree as before. A closing line counts the nested symbols the depth left out, and the structured result follows the requested depth, with the count as `omitted`.
