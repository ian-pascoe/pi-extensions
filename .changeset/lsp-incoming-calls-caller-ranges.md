---
"@ian-pascoe/pi-lsp": patch
---

Fix `lsp_incoming_calls` for callers in other files. Each incoming call's `fromRanges` are now converted against the caller's file text instead of the requested file's, so they no longer fail with `protocol position character exceeds line length` or return wrong columns after non-ASCII text.
