---
"@ian-pascoe/pi-utils": minor
"@ian-pascoe/pi-mcp": patch
"@ian-pascoe/pi-codemode": patch
"@ian-pascoe/pi-context-management": patch
"@ian-pascoe/pi-web-tools": patch
---

Add `stripControlCharacters` to `@ian-pascoe/pi-utils` and use it for transcript text sanitization in MCP, CodeMode, Context Management, and Web Tools. CodeMode observer text no longer leaves doubled spaces where control characters were removed.
