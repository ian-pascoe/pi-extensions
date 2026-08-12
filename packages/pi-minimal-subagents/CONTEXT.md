# Minimal Subagents context

## Purpose

Provide persistent, capability-bounded nested agents whose hierarchy and delivery state survive Pi session lifecycle changes.

## Glossary

- **Root Agent** — the interactive Pi agent that owns the top-level coordinator and may manage its complete descendant hierarchy.
- **Child Agent** — a persistent nested Pi session owned by exactly one parent agent.
- **Launch Contract** — the immutable model, tool, context, delegation, and depth capabilities captured when a Child Agent is created.
- **Runtime Profile** — the model and thinking level currently used by a Child Agent, initially derived from its Launch Contract but able to diverge during the session.
- **Registry** — append-only JSONL session records that reconstruct agents, turns, deletions, and pending deliveries.
- **Delivery Evidence** — a durable destination-session record proving that one completed child turn was delivered once.
