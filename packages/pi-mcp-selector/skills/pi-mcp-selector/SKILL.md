---
name: pi-mcp-selector
description: Diagnose Pi MCP Selector when `&server` autocomplete is missing or an MCP Server Reference does not convert to a link.
license: MIT
disable-model-invocation: true
---

# Pi MCP Selector

1. Read [`../../README.md`](../../README.md) for the reference syntax, the MCP Server Catalogue rules, and the completion popup.
2. For a missing server in the popup or a reference that stays literal, check the Catalogue first: `/mcp` must show the server enabled and connected with at least one tool that is not hidden. A server that is connecting, needs sign-in, or is disabled is absent by design. Finish when the server appears in the popup or this named state explains its absence.
3. For a missing popup, confirm extension loading and interactive mode, then try `&` after a space, then `&gi`. If another extension wraps the autocomplete provider without forwarding `triggerCharacters` (pi-fff 0.11.0 does not), press Tab after `&` to open the popup. `@` is Pi's file completion and never lists servers.
4. For a literal reference with the server present, compare the typed text with the submitted user message and check exact spelling and literal contexts: case, `&name/`, `&name.ext`, `&name:text`, `&name;` (an HTML entity), `R&D`, `a && b`, escapes, code, and links. Finish when the link targets the configured server name or a named boundary explains the mismatch.
5. If the link is correct but the model did not use the server, report conversion as working: the model controls tool use. Keep this extension configuration-free.
