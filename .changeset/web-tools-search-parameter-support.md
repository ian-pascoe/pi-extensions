---
"@ian-pascoe/pi-web-tools": minor
---

Web Search now says which Search Provider honors each optional parameter. A single support table, checked against the live provider schemas, drives static parameter descriptions: Exa honors `numResults` only, and Parallel honors none of `numResults`, `type`, `livecrawl`, or `contextMaxCharacters`. The tool definition stays identical whichever provider a session selects, so the prompt cache is unaffected. When a call explicitly supplies parameters the selected provider ignores, the result adds a warning such as `Parallel ignores: numResults, type.`: a `Warning:` line before the provider text the model reads, plus an optional `warnings: string[]` in `structuredContent` (script results) and in `details`, omitted when nothing is ignored. No request changes and no parameters are removed.
