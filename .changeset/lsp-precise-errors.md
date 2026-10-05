---
"@ian-pascoe/pi-lsp": patch
---

LSP tool errors now say what went wrong:

- An unsupported operation names the protocol method it needs, such as `textDocument/declaration`, and lists the matching servers that lack it.
- A missing file or a directory is rejected before any server is routed or started.
- A position past the end of the document is reported as an input error, not as a failed server request, and the message gives the document's line count or the line's length.
- A file that no server handles reads "no configured server matches <path>".
- An unknown `server_id` reads "server <id> is not configured".

The pointer to the troubleshooting Skill now appears only on server startup, crash, timeout, request, and configuration failures. Input errors and unsupported capabilities no longer show it.
