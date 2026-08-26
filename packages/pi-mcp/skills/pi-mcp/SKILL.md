---
name: pi-mcp
description: Configure or diagnose Pi MCP when settings are invalid, Servers fail to connect, authentication fails, or dynamic tools are missing.
license: MIT
---

# Pi MCP

Keep edits scoped to `mcp`. Store secrets behind `${NAME}` environment references and redact resolved values. Treat `/mcp` as human-operated: when unavailable, request one exact command and wait for its output. Use `/mcp test` for connectivity instead of invoking Server Tools, Prompts, or Resources.

1. Read the relevant settings, authentication, or connection section of [`../../README.md`](../../README.md).
2. Run `/mcp list`, then `/mcp status`. Stop when either identifies a decisive settings or state failure.
3. For a runtime failure, inspect `/mcp logs <server>`, then use `/mcp test <server>` after the cause is repaired.
4. Use `/mcp reconnect <server>` only for a repaired live definition.
5. Prefer the MCP Command Surface for requested mutations, then repeat `list`, `status`, and an approved `test`.
6. Finish when provenance is correct and the Server reaches its intended connected, disabled, or authentication-required state without exposing a secret.
