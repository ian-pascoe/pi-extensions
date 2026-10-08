---
"@ian-pascoe/pi-advisor": minor
"@ian-pascoe/pi-utils": minor
---

Cap each observed tool result's text in Advisor's Review Evidence, in the Context Seed and in incremental updates, to its head and tail around an omission marker that points at the observed session file. The cap is the new `maxToolResultChars` setting (default 4,000 characters); the Tool-Call Reference and error status are kept, user and assistant text and reasoning are never capped, and the Context Seed fit and token calibration measure the capped evidence. `@ian-pascoe/pi-utils/evidence` gains an opt-in `toolResultCap` projection option (and `capText`); Guardian does not use it and is unchanged.
