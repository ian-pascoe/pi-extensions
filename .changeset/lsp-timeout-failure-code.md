---
"@ian-pascoe/pi-lsp": patch
---

LSP tools and Post-edit Diagnostics recognize a timed-out language-server request from the client's own timeout instead of searching the error text for "timed out". A server error whose message happens to contain "timed out" now appears in `server_outcomes` as `error`, not `timeout`, and in Post-edit Diagnostics as an unavailable server rather than a diagnostics timeout. A server whose startup timed out is reported as unavailable in Post-edit Diagnostics, as it already was in `server_outcomes`. Timeouts still point to the troubleshooting Skill.
