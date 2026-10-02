---
"@ian-pascoe/pi-context-management": minor
---

`context_notes` and `context_history` now declare an `outputSchema` and return `structuredContent` built from the same serialization as their JSON text. A Pi `codemode` script receives the parsed object (for example `read.content` or `windows.nextOffset`) instead of a JSON string it had to parse. The model-facing text and error behavior are unchanged, and `context_rollover` is untouched because it cannot run inside a script. Scripts that called `JSON.parse` on these results must use the object directly. Pi appends a one-line result summary to each tool's description once.
