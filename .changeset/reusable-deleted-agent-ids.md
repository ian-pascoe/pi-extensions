---
"@ian-pascoe/pi-minimal-subagents": minor
---

**Behavior change:** Deleted Child Agent IDs can be reused. `subagent` with a deleted child's `agent_id` now creates a brand-new Child Agent with a fresh session and Launch Contract; nothing from the deleted child carries over. Generated `agent-N` IDs still skip deleted IDs, and spawning over a live child's ID still fails. Deletion also no longer races a spawn into the subtree being deleted or a branch change, and a tool call left over from a deleted child cannot act as the new one. Downgrade caveat: older versions treat re-creating a deleted ID as an invalid Registry record, so on a branch where an ID was reused they drop that agent (and its descendants) with a diagnostic; its session file is left untouched.
