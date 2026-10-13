---
"@ian-pascoe/pi-utils": minor
"@ian-pascoe/pi-minimal-subagents": minor
---

Add Agent Lineage Records. `@ian-pascoe/pi-utils/agent-lineage` defines a versioned session entry naming a Child Agent's session, its Root Agent's session, its agent ID, and its parent agent, plus `agentLineageRecord` and `readAgentLineage`. Minimal Subagents writes one into every new child session and into each fork clone when its destination adopts it, so other extensions can find a Child Agent's ancestors and descendants without depending on Minimal Subagents.
