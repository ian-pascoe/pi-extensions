---
status: accepted
---

# Retain MCP Clients across in-process session replacement

`@ian-pascoe/pi-mcp` retains live MCP Clients in a process-scoped MCP Client Pool across `/reload`, `/new`, `/resume`, and `/fork`. Each session-owned MCP Host holds an exclusive Session Lease; matching is per Server Definition using the canonical project root, trust state, and a salted in-memory digest of the effective resolved configuration, so changing one definition replaces only its client without exposing resolved secrets. Clients are never shared across projects, even for identical global definitions. This applies to stdio, Streamable HTTP, and legacy SSE transports.

A replacement session attaches immediately without a blocking health check and inherits the MCP Server's connection-scoped state; `/mcp reconnect` explicitly starts a fresh MCP connection. An unattached client expires after 30 seconds, while quit, process signals, project trust changes, relevant configuration or authentication changes, logout, disable, and removal close the affected client immediately. Ordinary OAuth token refresh remains with the retained client, while explicit or externally detected authentication binding changes invalidate it.

Pool-owned connection and initial catalog work may continue across a matching handoff. Session-bound tool, resource, and prompt operations are cancelled or drained before lease release and never cross sessions. An unleased client never starts a retry after failure; a closed or stale retained connection follows the replacement MCP Host's normal connection path.

Without a Session Lease, a pooled client fails closed on sampling, elicitation, and roots requests. It may retain catalog invalidations and resource-change markers, but the next MCP Host receives only changes relevant after reconciling its own desired subscriptions. Session Leases are exclusive: concurrently active AgentSessions, including Minimal Subagents Child Agents, use separate MCP Clients rather than multiplexing session contexts. Pool objects carry an explicit compatibility version; incompatible extension code closes them rather than adopting stale implementations.

The MCP Client Pool is a deep module below `McpHost`; it owns physical clients, fingerprints, leases, handoff expiry, and invalidation behind acquisition and release operations. It retains only the transport/client, negotiated capabilities and instructions, validated catalogs, and their invalidation generations. A replacement MCP Host reuses a validated catalog unless its generation was invalidated, coalescing handoff-gap changes into one refresh after attachment.

MCP Hosts, retries, Instruction Snapshots, desired resource subscriptions, tool registration, session files, callbacks, and presentation remain session-owned so retained clients cannot act through stale Pi contexts. `/mcp status` reports reuse and connection age without adding another authoritative Host status state. `/mcp test` and standalone `pi-mcp test` keep using isolated temporary clients.

An incompatible or corrupt pool entry is closed best-effort and replaced with a fresh connection without blocking Pi startup; stale callbacks still fail closed. This supersedes only ADR-0002's decision that every connection is owned by one session and ephemeral. Catalogs are registered only after session-start reconciliation, using bounded scheduler yields and no private Pi APIs; extension factories lack the public project and trust context needed to restore them safely.
