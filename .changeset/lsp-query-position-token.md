---
"@ian-pascoe/pi-lsp": minor
---

Position-based query results now echo the token at the requested position, so off-by-one positions are visible. Results start with `Query position: src/a.ts:1:14 ("value")`, or show the trimmed line when the position is on whitespace or past the line end. When no server found anything, the result says so for that position, such as `No call hierarchy item at src/todo.ts:61:18 ("readonly").` or `No completions start with "r" at …`; the hierarchy follow-ups tell a position without a hierarchy item apart from an item without calls or types. Structured Results of position tools add `position: { path, line, character, token?, line_text }`. `lsp_hover`, `lsp_signature_help`, and `lsp_prepare_rename` put this line before their JSON, and their result rows count results.
