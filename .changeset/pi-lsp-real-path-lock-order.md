---
"@ian-pascoe/pi-lsp": patch
---

Applying a Workspace Edit that names a symlink, for example to delete or rename it, no longer risks deadlocking with a concurrent formatting or with itself when it also names the symlink's target. Pi LSP now locks files sorted by real path, the same order Pi Formatter uses.
