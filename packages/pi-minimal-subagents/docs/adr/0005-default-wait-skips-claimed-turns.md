---
status: accepted
---

# Skip claimed turns in default `subagent_wait` selection

Without `turn_id`, `subagent_wait` selects the oldest unclaimed observable turn, in Delivery Ledger sequence order, and falls back to the active turn, then the latest turn, when none remains. This supersedes the default-selection rule of [ADR-0001](0001-wait-event-delivery-ordering.md), which prioritized the oldest claimed turn. That rule made the documented workflow (claim a result, `agent_message` the idle child, wait on the `started-turn`) return the already-claimed first result again, both while the new turn ran and after it was cancelled.

ADR-0001 otherwise remains in force. An explicit `turn_id` still addresses any retained turn, claimed or not, and returns the same settled result on repeated waits. Claims remain durable Delivery Ledger state and behave as before across reloads and forks; automatic fallback is unchanged. Claimed wait-only terminal results stay retained (bounded at 20 per source, per [ADR-0003](0003-persisted-delivery-ledger.md)) so an explicit `turn_id` can still reach them, but they no longer attract default waits. Unclaimed settled turns are still returned oldest first.
