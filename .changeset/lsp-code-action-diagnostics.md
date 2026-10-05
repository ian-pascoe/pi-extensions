---
"@ian-pascoe/pi-lsp": patch
---

`lsp_code_actions` now returns diagnostic-dependent quick fixes, such as adding a missing import. The request sends the selected server's current LSP Diagnostics that overlap the range instead of an empty list. It uses diagnostics the server already reported for the file's current contents, otherwise waits for fresh push or pull diagnostics within the diagnostics timeout. When diagnostics are unavailable, the code-action request still runs.
