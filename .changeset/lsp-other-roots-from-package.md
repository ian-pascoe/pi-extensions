---
"@ian-pascoe/pi-lsp": patch
---

`lsp_find_references` and `lsp_rename` now warn about sibling workspace roots when Pi starts inside a package. Discovery of other roots of the same Server Definition starts from the outermost ancestor of the searched root that contains one of its root markers, instead of from Pi's working directory, so with Pi in `packages/a` the warning lists `packages/b` and the repository root before their servers have started. Discovery starts no higher than that directory, and never at your home directory or above it unless Pi's working directory is at or above it. It keeps its limits: it skips symbolic links, hidden directories, and `node_modules`, and checks at most 4,096 directories.
