---
"@ian-pascoe/pi-lsp": patch
---

`lsp_rename`, `lsp_format_document`, `lsp_format_range`, and `lsp_format_on_type` now report a server that times out or crashes, while synchronizing the document or answering the request, the way read tools and `lsp_code_actions` do: `Pi LSP: server <id> request failed: …`, followed by the pointer to the troubleshooting Skill. Before, the raw client error escaped without the server label or the pointer. A position past the end of the document is still an input error without the pointer. A cancelled request, such as an aborted tool call, now ends every LSP tool with the plain cancellation error, without a server label or the pointer.
