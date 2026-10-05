---
"@ian-pascoe/pi-lsp": patch
---

LSP tool errors say what went wrong. An unsupported operation names the protocol method it needs, such as `textDocument/declaration`, and the matching servers that lack it. A missing file or directory and a position past the end of the document are reported as input errors before any server is asked, and position errors give the document's line count or the line's length. A file no server handles reads "no configured server matches <path>", and an unknown `server_id` reads "server <id> is not configured". The pointer to the troubleshooting Skill now appears only for server startup, crash, timeout, request, and configuration failures, not for input errors or unsupported capabilities.
