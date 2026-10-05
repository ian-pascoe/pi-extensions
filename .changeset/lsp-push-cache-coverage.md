---
"@ian-pascoe/pi-lsp": patch
---

`lsp_workspace_diagnostics` now says what a result from pushed diagnostics covers. When a server has no workspace pull, the result carries a `message` stating that the server publishes no workspace diagnostics, how many files opened in this session the pushed diagnostics cover (including files with none), and that `lsp_diagnostics` checks other files. An empty result can no longer be read as a clean workspace. Workspace pull results are unchanged.
