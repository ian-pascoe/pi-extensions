# Pi MCP

Pi MCP makes Pi an MCP Host for configured MCP Servers. It presents the core
protocol capabilities through Pi.

## Language

**MCP Host**:
The Pi-side runtime that coordinates MCP Clients and presents MCP Server capabilities to Pi.
_Avoid_: Adapter, MCP server

**MCP Client**:
The protocol participant maintained by the MCP Host for one MCP Server connection.
_Avoid_: Host, adapter

**MCP Server**:
An external local or remote program that offers capabilities to the MCP Host.
_Avoid_: Provider, integration

**Server Definition**:
Named configuration identifying an MCP Server and how the MCP Host connects to it.
_Avoid_: Server, connection

**Server Tool**:
An MCP tool presented to Pi as an individually callable model tool.
_Avoid_: Pi built-in tool, MCP management tool

**Server Instructions**:
MCP Server-provided guidance presented to the model by the MCP Host. It is not Pi policy.
_Avoid_: System prompt, host policy

**Instruction Snapshot**:
The immutable, deterministically ordered Server Instructions included in a Pi session's model prompt.
_Avoid_: Live instructions, instruction cache

**MCP Observer UI**:
The read-only, non-authoritative presentation of MCP activity and state for the person supervising the current Pi session. It cannot change configuration or runtime state.
_Avoid_: MCP control panel, audit UI

**MCP Observer Snapshot**:
A bounded summary of current MCP Server health derived for the MCP Observer UI. It is a projection, not a second source of runtime truth.
_Avoid_: Host state, Server status

**MCP Transcript Presentation**:
The semantic, human-facing rendering of MCP activity within Pi's session transcript. It does not change the messages or results visible to the model.
_Avoid_: Model result, MCP log

**MCP Attention Notice**:
A human-only presentation that an MCP condition requires action from the person supervising the session. It does not enter model context.
_Avoid_: Server Instructions, tool result

**MCP Command Surface**:
The human-operated `/mcp` and `pi-mcp` commands for inspecting or changing MCP configuration and runtime state. It remains distinct from the passive MCP Observer UI even when its read-only output supports observation.
_Avoid_: Observer UI, MCP management tool

**MCP Client Pool**:
The process-scoped owner of MCP Clients retained between in-process Pi session replacements. It partitions clients by trusted project and effective Server Definition.
_Avoid_: Connection cache, daemon

**Session Lease**:
The exclusive binding of one session-owned MCP Host to a pooled MCP Client. It directs session-scoped protocol interactions and presentation without transferring client ownership.
_Avoid_: Shared session, connection ownership
