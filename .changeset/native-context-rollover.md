---
"@ian-pascoe/pi-context-management": patch
---

Use Pi's native compaction accounting, triggers, and recent-history retention instead of separate budget estimates and thresholds. Normal automatic and manual compaction now requests fresh Notes and an agent-written Handoff before Rollover; actual overflow retains immediate saved-state recovery. Report unfinished preparation without repeated reminders or stale fallback, and ignore obsolete `contextManagement` settings with one migration warning per session load.
