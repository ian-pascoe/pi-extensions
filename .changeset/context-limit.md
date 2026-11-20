---
"@ian-pascoe/pi-context-management": minor
---

Limit the context window Pi accounts against to `contextManagement.maxContextTokens` (default 400,000). When a selected model declares a larger window, such as a 1M-token model, Pi's usage display, compaction threshold, overflow detection, and output clamp use the limit instead. Models with smaller windows are unchanged.
