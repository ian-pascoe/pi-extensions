# Pi MCP Selector

Pi MCP Selector lets users point the model at MCP servers within a user message.

## Language

**MCP Server Reference**:
An explicit mention of an MCP server in a user message, written `@server-name` or as a Markdown link to `mcp://server-name`. It points the model to the server's tools without connecting, loading, or exposing them.
_Avoid_: MCP mention, attached server, server tag

**MCP Server Catalogue**:
The MCP servers the current session can reach: enabled, connected servers with at least one tool that is not hidden, whether configured in `mcp.json` or registered by an extension.
_Avoid_: Server registry, server list
