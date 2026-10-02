---
"@ian-pascoe/pi-context-management": minor
---

`context_notes` and `context_history` now declare an `outputSchema` and return `structuredContent` built from the same serialization as their JSON text. A Pi `codemode` script receives the parsed object with snake_case fields (for example `read.total_characters` or `windows.next_offset`) instead of a JSON string it had to parse. The model-facing JSON text (camelCase), persisted session `details`, and error behavior are unchanged, and `context_rollover` is untouched because it cannot run inside a script. Scripts that called `JSON.parse` on these results must use the object directly and its snake_case field names. Pi appends a one-line result summary to each tool's description once.
