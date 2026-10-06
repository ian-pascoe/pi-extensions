---
"@ian-pascoe/pi-minimal-subagents": minor
---

**Behavior change:** Child Agents that cannot spawn now get only `agent_message`, dropping the unusable `subagent_wait` and `subagent_status` definitions from every child request (child CodeMode scripts lose those two tools). Fanout children below the depth cap keep all six Coordinator Tools; a fanout child at the cap now gets only `agent_message`.
