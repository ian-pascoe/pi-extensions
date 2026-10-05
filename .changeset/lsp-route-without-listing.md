---
"@ian-pascoe/pi-lsp": patch
---

LSP routing no longer lists a file's ancestor directories when none of the enabled servers that handle its language has root markers. Such servers use the working directory as their root, so each tool call and Post-edit Diagnostics skip the directory reads, which were slow for files under large directories such as a home or downloads folder. Routing is unchanged when a matching server has root markers.
