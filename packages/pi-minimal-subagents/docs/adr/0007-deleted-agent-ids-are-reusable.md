# Deleted Agent IDs are reusable

Deleting a Child Agent used to tombstone its Agent ID for the life of the Root Agent branch, so `subagent` could never name it again. That forced a new ID every time an agent was deleted and respawned for the same role, which is a common pattern. Deleting now frees the Agent ID: a later `subagent` naming it creates an unrelated Child Agent with a fresh session and Launch Contract, and nothing from the deleted agent carries over.

The Registry keeps its `tombstones` field and validation unchanged, so no schema version or migration is needed. Replay accepts `agent-created` for a deleted Agent ID whose parent is live and removes it from the tombstones; only a live duplicate is rejected. The tombstones still keep generated `agent-N` IDs from recycling, so a parent's earlier mention of `agent-3` never points at a new agent, and still mark a legacy `root.` hierarchy.

We did not add a per-incarnation generation counter. Turn IDs and session IDs already carry a UUID, so Delivery Evidence, the Delivery Ledger, exact-`turn_id` waits, and Agent Lineage Records already keep old and new agents apart; a counter would have changed the Registry, lineage, and evidence formats across packages. What reuse did expose were process-local maps keyed by the bare Agent ID: deletion now clears them, checks that each record is still the current agent before acting, blocks spawns into a subtree while it is being deleted, and coordinator tools reject a caller whose session no longer owns its Agent ID.

Older package versions report re-creating a deleted Agent ID as an invalid record and drop that agent on branches where an ID was reused, under ADR-0004's local degradation.
