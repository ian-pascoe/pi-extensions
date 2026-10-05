---
"@ian-pascoe/pi-minimal-subagents": patch
---

`subagent_wait` without `turn_id` now skips turns whose terminal result you already claimed. After waiting on a child's first result and sending `agent_message` (which reports `started-turn` with a new `turn_id`), `subagent_wait({ agent_id })` targets the new turn, both while it runs and after it is cancelled, instead of returning the first result again. It selects the oldest unclaimed observable turn, then the active turn, then the latest turn; unclaimed settled turns are still returned oldest first, and an explicit `turn_id` still addresses any retained turn, claimed or not. Delivery Ledger persistence and automatic fallback are unchanged.
