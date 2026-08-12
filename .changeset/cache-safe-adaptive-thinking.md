---
"pi-adaptive-thinking": minor
---

Keep prompt caching stable by replacing per-turn system-prompt mutation with static tool guidance. Add `get_thinking_level` for inspecting native current and model-supported levels, plus `guidance` and `statusToolName` configuration. The former `systemPrompt` field remains a deprecated alias during the `0.x` release line.
