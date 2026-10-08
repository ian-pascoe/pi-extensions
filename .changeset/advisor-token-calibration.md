---
"@ian-pascoe/pi-advisor": patch
---

Measure `seedBudgetTokens` and the incremental-evidence check in the Advisor model's reported tokens rather than Pi's chars/4 estimate, which undercounts Review Evidence by about 1.7–1.9× on Claude models. A seed fitted to an estimated 100k reached about 175k real tokens and pushed the Advisor Session past `maxSessionTokens` at once, forcing an uncached compaction. Advisor now scales the estimate by a per-model factor learned from its own Reviews and Consultations (the input tokens a prompt added against Pi's estimate of it), starting from a conservative factor of 2. A first seed is therefore smaller until the model reports usage.
