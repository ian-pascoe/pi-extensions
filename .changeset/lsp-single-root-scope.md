---
"@ian-pascoe/pi-lsp": minor
---

`lsp_find_references` and `lsp_rename` now name the workspace root they searched. Each root gets its own server, so in a monorepo a rename could miss every importing package without saying so. When the same server has other roots, either running or found by root markers under the working directory, both tools warn that files outside the searched root may be missing. The rename warning starts the Workspace Edit Preview summary, so it is visible before `lsp_apply`. Preview structured results add `root_path` and `warnings`.
