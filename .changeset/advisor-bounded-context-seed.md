---
"@ian-pascoe/pi-advisor": minor
---

Enabling Advisor partway through a long session no longer sends the entire conversation to its first Review or Consultation. The new `seedBudgetTokens` setting (default `auto`, a quarter of the Advisor model's context window) bounds that first context: it always keeps the observed system prompt, tool summaries, and original request, then the newest messages that fit, and tells the Advisor how many earlier messages were omitted and where granted tools can find them.
