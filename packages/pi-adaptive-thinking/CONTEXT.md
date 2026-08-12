# Adaptive Thinking context

## Glossary

- **Session Baseline** — the thinking level retained for the active Pi session after a persistent change or user selection.
- **Temporary Thinking Level** — a thinking level applied for one agent turn and restored to the Session Baseline at turn end.

## Behavior boundary

The extension owns the `set_thinking_level` tool and configuration precedence between project, global, and built-in settings. It protects Pi's global default setting while changing only the active session level.
