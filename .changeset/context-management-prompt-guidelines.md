---
"@ian-pascoe/pi-context-management": patch
---

Context Management no longer replaces the whole system prompt in `before_agent_start`. That forced prompt rebuilt each request's leading system message, so a tool activated mid-session (for example by `tool_search`) and a turn started by an idle custom message (for example a pi-termctrl Exit notification) changed the prompt prefix, missing the prompt cache and making Anthropic drop prefix-bound thinking blocks. The guidance is now `promptGuidelines` on `context_notes`, `context_history`, and `context_rollover`, which Pi keeps in its default prompt across every run. A custom system prompt (`SYSTEM.md`) omits tool guidelines, so it no longer carries this guidance.
