---
"@ian-pascoe/pi-context-management": patch
---

Coexist with summarizer overrides such as `pi-claude-bridge`. Manual and threshold compaction are claimed before other hooks run, and another hook's overflow summary is replaced by the Emergency Rollover with a warning rather than stopping Context Management. Direct `context_rollover` checkpoints now emit Pi's `session_compact` event so provider session caches rebuild from the new Context Window.

Fix every compaction failing with "compaction result missing or replaced" on Pi 0.87, which stores a wrapper for each `pi.on` handler. Context Management no longer finds its own compaction hook by function identity.
