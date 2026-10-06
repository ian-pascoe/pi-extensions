---
"@ian-pascoe/pi-advisor": minor
---

Enabling Advisor partway through a long session no longer sends the entire conversation to its first Review or Consultation. The new `seedBudgetTokens` setting (default `auto`, a quarter of the Advisor model's context window) bounds that first context. It always keeps the observed system prompt, tool summaries, original request, and newest turn, then the newest turns that fit, shortening oversized text with a marker. It tells the Advisor which observed messages it kept and where granted tools can find the rest. After a cancelled Consultation, the next Review or Consultation now receives the full context again instead of only newer messages.
