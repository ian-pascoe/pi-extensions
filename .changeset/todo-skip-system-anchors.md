---
"@ian-pascoe/pi-todo": patch
---

Keep Todo snapshots working after compaction on Pi 0.87. Compaction checkpoints now carry a system snapshot that `context` handlers never receive, so Todo projection anchors on the first conversation message instead of failing with "anchor is missing or ambiguous".
