# Separate Observer presentation from model output and command control

Pi MCP presents activity through three distinct human-facing paths. MCP Transcript Presentation gives Server Tool calls, Resource operations, Prompts, and Resource Update Notices a semantic rendering. The MCP Observer UI projects current MCP Server health through a TUI footer and human-only Attention Notices. The MCP Command Surface and existing protocol dialogs remain the human paths that can act.

Model-visible Server Tool results, Prompt replay, and Resource Update Notice content remain independent from those presentations. Transcript renderers consume existing arguments, content, and bounded details, while the Observer UI consumes MCP Host status already known to the runtime. Neither path sends an MCP request or invokes a command. Tool renderers also apply to Pi's HTML transcript export; live health and Attention Notices remain TUI-only.

This separation adds a small bounded projection beside authoritative Host state, but it keeps human presentation failures out of protocol behavior, preserves model output, and prevents passive status UI from becoming a second control surface. A full MCP catalog browser, control panel, and heuristic secret masking remain outside this boundary.
