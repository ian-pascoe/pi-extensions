---
"@ian-pascoe/pi-lsp": patch
---

Applying a Workspace Edit that deletes, renames, or creates through a symlink no longer risks deadlocking with a concurrent formatting or waiting on itself. Pi LSP now locks each file once, ordered by its real path like Pi Formatter does.
