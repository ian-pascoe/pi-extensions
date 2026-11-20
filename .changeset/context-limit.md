---
"@ian-pascoe/pi-context-management": minor
---

Add a Context Limit, `contextManagement.maxContextTokens` (default 400,000). When a selected model declares a larger window, such as a 1M-token model, Pi's usage display, compaction threshold, and overflow detection use the limit instead; the session's own model requests still carry the declared window. Models with smaller windows are unchanged.
