---
"@ian-pascoe/pi-minimal-subagents": minor
---

Add Subagent Model References. Type `%` in a user message to pick a model role or an eligible model from a completion popup. On submission, `%large` or `%claude-opus-5-5` becomes a link that names the `subagent` argument the Root Agent can pass (`role=large` or `model=anthropic/claude-opus-5-5`). References convert only while the Root Agent can reach `subagent`. They change neither the tool definitions nor the system prompt.
