---
"@ian-pascoe/pi-minimal-subagents": patch
---

A default `subagent_wait` no longer hands back a result that was already delivered automatically: it returns `already_delivered: true` with the turn identity and status, and `turn_id` rereads the full result.
