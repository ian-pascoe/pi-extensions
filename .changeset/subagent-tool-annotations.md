---
"@ian-pascoe/pi-minimal-subagents": minor
---

The coordinator tools now declare MCP-style tool `annotations`, reported through `pi.getAllTools()` for permission extensions. `subagent` is destructive and open-world because a Child Agent can use any tool it is granted; `agent_message` is non-destructive and closed-world; `subagent_status` and `subagent_wait` are read-only; `subagent_cancel` is non-destructive and idempotent; `subagent_delete` is destructive and idempotent. Annotations are not sent to model providers, so tool declarations, the system prompt, and the prompt cache prefix are unchanged.
