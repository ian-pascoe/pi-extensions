---
"@ian-pascoe/pi-utils": minor
---

Add `expectToolOutputMatches`, `toolOutputViolations`, and `recordToolOutputs` to `@ian-pascoe/pi-utils/tool-testing`. `expectToolOutputMatches(tool, result)` throws when a result sets `structuredContent` for a tool with no `outputSchema` (codemode scripts would get the text instead), when a successful result of a tool with an `outputSchema` sets none, or when `structuredContent` violates the schema, listing every violation; `toolOutputViolations` is its non-throwing core. `recordToolOutputs(getToolDefinition)` returns an extension that records every `tool_result` of an SDK session, nested codemode calls included, with the declaration its tool had when the result fired; load it last and call its `check()` once the prompts finish.
