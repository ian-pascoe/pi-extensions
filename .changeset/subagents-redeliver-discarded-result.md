---
"@ian-pascoe/pi-minimal-subagents": patch
---

A child result queued to the root is no longer lost when Pi discards the queued message before the model sees it, for example when Esc interrupts the root turn. At the root's next turn boundary with nothing left in Pi's queue, a queued result without Delivery Evidence becomes selectable by a default `subagent_wait` again, together with any Coordination Messages batched into it. Automatic fallback re-sends it when the root's next run starts, ahead of newer results, and never starts a root turn by itself, so Esc stays respected. A result the root already received is settled instead, so it is never delivered twice. An automatic hand-off whose grace period spans a session branch change is now abandoned, leaving delivery to the selected branch's replay.
