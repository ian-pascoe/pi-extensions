---
"@ian-pascoe/pi-lsp": patch
---

`lsp_code_actions` now applies `only_kinds` itself instead of trusting the server to filter. A requested kind matches itself and its dot-separated sub-kinds (`quickfix` matches `quickfix.import`, not `quickfixes`). Actions of other kinds, actions without a kind, and plain commands are dropped. Without `only_kinds`, every action is still returned.
