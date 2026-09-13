---
"@ian-pascoe/pi-lsp": patch
"@ian-pascoe/pi-dap": patch
---

Fix LSP and DAP startup with `pi --no-session` by using a private OS temporary directory when Pi supplies an empty session directory. Result Spills and stderr files retain their existing permissions and normal teardown cleanup.
