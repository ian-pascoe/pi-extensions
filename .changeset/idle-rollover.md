---
"@ian-pascoe/pi-context-management": minor
---

Add Idle Rollover, modelled on Claude Code's idle compaction: when an interactive session with at least 200,000 tokens of context sits idle until just before its provider prompt cache expires (after any Pi idle cache warming stops), the agent refreshes Notes, writes a Handoff, and rolls over, so the next message does not resend the whole Context Window uncached. Configure it with `contextManagement.idleRollover: { enabled, minTokens }`; the obsolete-settings warning no longer fires for that key.
