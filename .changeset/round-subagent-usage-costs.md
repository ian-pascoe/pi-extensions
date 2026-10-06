---
"@ian-pascoe/pi-minimal-subagents": patch
---

`subagent_wait` and `subagent_status` now round `usage.cost` fields to six decimal places of USD in their text and `structuredContent`, so results no longer show float-noise tails such as `0.000022999999999999997`.
