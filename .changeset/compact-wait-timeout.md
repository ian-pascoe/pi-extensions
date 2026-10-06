---
"@ian-pascoe/pi-minimal-subagents": minor
---

**Behavior change:** `subagent_wait` timeouts now return a compact progress snapshot (`state`, `elapsed_ms`, `latest_activity_at`, `total_tokens`, `recent_activity_labels`) instead of the full child `agent` status, and `latest_activity_at` advances while a child works.
