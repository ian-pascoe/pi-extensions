# Minimal Subagents context

## Purpose

Provide persistent, capability-bounded nested agents whose hierarchy and terminal-result delivery state survive Pi session lifecycle changes.

## Glossary

- **Root Agent** — the interactive Pi agent that owns the top-level coordinator and may manage its complete descendant hierarchy.
- **Child Agent** — a persistent nested Pi session owned by exactly one parent agent.
- **Launch Contract** — the immutable model, tool, context, delegation, and depth capabilities captured when a Child Agent is created.
- **Runtime Profile** — the model and thinking level currently used by a Child Agent, initially derived from its Launch Contract but able to diverge during the session.
- **Registry** — append-only JSONL session records that reconstruct agents, turns, deletions, and pending deliveries.
- **Delivery Evidence** — a durable destination-session record proving that one completed child turn was delivered once.
- **Coordination Message** — a mid-turn message between adjacent agents, identified by its source agent, source turn, and message ID.
- **Wait Event** — one `subagent_wait` result; it is either an intermediate Coordination Message or a terminal turn result.

## Delivery ordering

An active direct-parent wait is the first delivery path for a child
Coordination Message. Consuming a message wakes that wait without also
enqueueing a duplicate Pi steer message; the parent calls `subagent_wait`
again to observe the same source turn's terminal result. A successful message
wait claims the complete source turn, keeping later Coordination Messages
available to subsequent waits. Returning the terminal Wait Event claims the
terminal delivery and suppresses its automatic Pi message. Without a wait
claim, Coordination Messages and automatic results use the ordered recipient
queue. Automatic fallback does not enter an active recipient conversation;
each deferred item retains its recipient-queue reservation until the recipient
settles or a wait claims it, preserving ordering across source turns. Held
reservations remain coordinator-owned pending work and drain before reload or
fork disposal.

Child turn outcomes are collected from finalized session events rather than a
slice of mutable in-memory context, so compaction cannot erase a response that
already completed.
