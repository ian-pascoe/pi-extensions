---
"@ian-pascoe/pi-minimal-subagents": patch
---

A child result queued to the root is delivered again when Pi discards the queued message before the model sees it, for example when Esc interrupts the root turn. At the root's next turn boundary with nothing left in Pi's queue, a queued result without Delivery Evidence becomes selectable by a default `subagent_wait` again, and automatic fallback queues it again with any Coordination Messages batched into it. A result the root already received is settled instead, so it is never delivered twice.
