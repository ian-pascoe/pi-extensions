---
"@ian-pascoe/pi-advisor": minor
---

When `thinkingLevel` is not configured, the Advisor now uses a fixed `high` thinking level instead of inheriting the observed agent's. Explicit `thinkingLevel` settings and global/project/session layering are unchanged, and an observed thinking-level change no longer discards the Advisor Session.
