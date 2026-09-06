---
"@ian-pascoe/pi-context-management": minor
---

Replace the exact Pi version restriction with runtime capability checks for checkpoint, session, budget, and trusted-settings APIs. Preserve fail-closed behavior when required capabilities are missing or lost. Allow passive compaction listeners, including inactive Autoresearch, while cancelling actual competing summaries before persistence and preventing native summarizer fallback.
