---
"@ian-pascoe/pi-minimal-subagents": patch
---

Give Child Agents that cannot spawn only `agent_message`, dropping the unusable `subagent_wait` and `subagent_status` definitions from every child request. Fanout children keep all six Coordinator Tools.
