# Minimal Subagents context

## Purpose

Provide persistent, capability-bounded nested agents whose hierarchy, conversation position, and ordered delivery state follow Pi session branches and lifecycle changes.

## Glossary

- **Root Agent** — the interactive Pi agent that owns the top-level coordinator and may manage its complete descendant hierarchy.
- **Child Agent** — a persistent nested Pi session owned by exactly one parent agent.
- **Launch Contract** — the immutable model, tool, context, delegation, and depth capabilities captured when a Child Agent is created.
- **Runtime Profile** — the model and thinking level currently used by a Child Agent, initially derived from its Launch Contract but able to diverge during the session.
- **Registry** — append-only, active-branch Registry V2 JSONL records that reconstruct agents, turns, deletions, clock-stamped activity, and the Delivery Ledger; valid V1 records migrate on replay.
- **Delivery Ledger** — the pure state machine owning sequence, claim, settlement, selection, pruning, and bounded terminal-retention transitions for pending deliveries.
- **Delivery Evidence** — a durable destination-session record proving that one Delivery Ledger item reached its destination.
- **Coordination Message** — a mid-turn message between adjacent agents, identified by stable delivery, source-agent, source-turn, and message IDs.
- **Wait Event** — one `subagent_wait` result; it is either an intermediate Coordination Message or a terminal turn result.
- **Child Session Position** — the verified child-session leaf recorded for the active Root Agent branch.
- **Fork Snapshot** — the selected branch's Registry state plus independently cloned child sessions carrying verified source provenance and destination-root ownership.

## Delivery ordering

An active direct-parent wait is the first delivery path for a child Coordination Message. Consuming a message wakes that wait without also enqueueing a duplicate Pi steer message. A successful message wait durably claims the complete source turn, keeping later Coordination Messages and the terminal result available across reload, fork, or a newer child turn. An optional exact `turn_id` can address retained older work; the default selects the oldest observable turn. One caller cannot hold two concurrent waits for the same source turn.

Without a wait claim, Coordination Messages and terminal results use their persisted Delivery Ledger sequence and ordered recipient queue. New item sequences are unique and strictly increasing across both kinds but may contain gaps; updates preserve the item's sequence. Claims name only active, latest, or retained source turns. Idle notifications are advisory: automatic fallback rechecks actual recipient idleness after every wake and immediately before delivery. Delivery Evidence settles and removes pending items. Wait-only terminal retention is capped at 20 items per source agent without pruning Coordination Messages. Deleting a complete live subtree prunes its orphaned ledger items and recent-message projections.

## Session lifecycle

Registry replay and Delivery Evidence use only `SessionManager.getBranch()`. Tree navigation invalidates old process-local queues and waiters, restores the selected branch, and reopens each verified Child Session Position. Fork preparation performs no coordinator mutation. A confirmed fork shutdown materializes clones with a new generation-specific identity/provenance pair; the destination appends ownership matching the current clone session ID before restore and ignores ownership inherited from older generations. Process-loss recovery uses the copied destination branch only when canonical `parentSession` provenance proves its source. A canceled or unprovable fork never substitutes the source head.

Child turn outcomes are collected from finalized session events rather than mutable post-compaction context. Registry V2 parsing validates every persisted field plus identity, hierarchy, sequence, adjacency, destination, ordinary-tool ceiling, coordinator-tool exclusion, claim, deletion, and selected-leaf invariants. Unavailable recovery placeholders are the only V2 agents allowed without a selected leaf. Valid Registry V1 records migrate to V2 state; malformed records produce semantic diagnostics and degrade locally. Restoration dependency or session-identity failures make only the affected Child Agent unavailable.
