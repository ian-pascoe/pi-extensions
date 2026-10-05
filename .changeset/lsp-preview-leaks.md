---
"@ian-pascoe/pi-lsp": patch
---

`lsp_code_actions`, `lsp_rename`, and the `lsp_format_*` tools no longer leave Workspace Edit Previews behind that no result names. When a call fails after a preview was created, such as when a second server rejects the request's position or the full output cannot be written to a Result Spill, those previews are discarded and can no longer be applied. Server-initiated previews are kept for the next result after such a failure. Read tools and `lsp_code_actions` now wait for every queried server that already started its request to answer or fail before they fail, with the same error as before; a server that is still starting is not waited for.
