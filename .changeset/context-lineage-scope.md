---
"@ian-pascoe/pi-context-management": minor
---

Read the Notes and History of the agents in this agent's lineage. `context_notes` `list`/`search` and `context_history` `search` accept `scope: "lineage"`, covering the sessions of the agents that spawned this agent and that it spawned, labelled by agent. Refs from those results work with `read`, and the new `context_notes` `copy` action saves another agent's Note into your own Notes as an unlinked snapshot. Other sessions are read live from their files and never written. Lineage comes from the Agent Lineage Record in `@ian-pascoe/pi-utils`, which `@ian-pascoe/pi-minimal-subagents` writes; without it the scope covers only the current session.
