---
"@ian-pascoe/pi-advisor": patch
---

Stop declaring granted `codemode` and `deferred` tools, including MCP tools, to the Advisor model. Pi's `tools` option activated every granted tool, so the Advisor request carried script-only tools in its tool list. They now stay callable from granted `codemode` scripts and can still be declared through `tool_search`, as for Minimal Subagents Child Agents.
