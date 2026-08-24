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
