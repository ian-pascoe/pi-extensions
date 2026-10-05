---
"@ian-pascoe/pi-minimal-subagents": patch
---

A `subagent_wait` timeout is no longer treated as Delivery Evidence for the waited-on turn's final result. Before, after a wait timed out on a running turn, the root session held a wait tool result for that turn, so reconciliation settled the later automatic result as delivered without it ever reaching the parent. Timeout results now count like intermediate message results: only a wait that returned the turn's terminal result, or the automatic result message itself, proves delivery.
