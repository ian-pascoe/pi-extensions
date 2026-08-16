---
"@ian-pascoe/pi-minimal-subagents": minor
---

Deliver child coordination messages through active waits before queuing them in
Pi, keep later messages on a wait-claimed turn ahead of its terminal result,
defer fallback while the recipient is active, and suppress automatic terminal
delivery after a successful wait. Preserve completed outcomes across compaction
and fix fork clone session identity and provenance. Clarify bundled versus exact
ordinary-tool selection.
