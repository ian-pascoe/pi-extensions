# Adaptive Thinking context

## Glossary

- **Session Baseline** — the thinking level retained for the active Pi session after a persistent change or user selection.
- **Temporary Thinking Level** — a thinking level applied for one agent turn and restored to the Session Baseline at turn end.
- **Thinking Level Status** — the current native Pi thinking level and the levels supported by the selected model.

## Behavior boundary

The extension owns the `get_thinking_level` and `set_thinking_level` tools and configuration precedence between project, global, and built-in settings. It protects Pi's global default setting while changing only the active session level.

Pi's native thinking-level state is authoritative. Status inspection and setter no-op detection read it at tool execution time.

## Cache-safety boundary

The extension never replaces Pi's per-turn system prompt. Configured guidance and tool names are static tool metadata established at session start. Current level, supported levels, selected model, and other runtime state appear only in tool results, never in prompt metadata.
