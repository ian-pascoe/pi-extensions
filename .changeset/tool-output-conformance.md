---
"@ian-pascoe/pi-utils": minor
---

Add `expectToolOutputMatches` and `recordToolOutputs` to `@ian-pascoe/pi-utils/tool-testing`. `expectToolOutputMatches(tool, result)` throws when a result sets `structuredContent` for a tool with no `outputSchema` (codemode scripts would get the text instead), when a successful result of a tool with an `outputSchema` sets none, or when `structuredContent` violates the schema, listing every violation. `recordToolOutputs()` returns an extension that records every `tool_result` of an SDK session, nested codemode calls included; load it last and call its `check(name => session.getToolDefinition(name))` once the prompts finish.
