---
"@ian-pascoe/pi-utils": minor
"@ian-pascoe/pi-mcp": patch
"@ian-pascoe/pi-lsp": patch
"@ian-pascoe/pi-minimal-subagents": patch
---

Add `updateFileLocked` (`@ian-pascoe/pi-utils/locked-file-update`), which atomically updates a file under Pi's native settings lock. MCP, LSP, and Minimal Subagents settings commands now share it. MCP settings and authentication writes now take Pi's `settings.json.lock` instead of a private `.pi-mcp.lock`, so they serialize with Pi's own settings writes and follow symlinked settings files.
