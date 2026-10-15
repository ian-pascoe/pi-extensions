---
"@ian-pascoe/pi-context-management": minor
---

Keep no recent History Tail after a normal Rollover by default. The Handoff, Notes, and History now carry continuity, as in Codex's experimental context management. Configure the Tail with `contextManagement.tailTokens` (nonnegative integer, default 0); it replaces Pi's `keepRecentTokens` for normal Rollover only, while Emergency Rollover keeps Pi's native retention. `tailTokens` is no longer reported as an obsolete setting, so a value left over from older versions now takes effect. `/context` reports both values.
