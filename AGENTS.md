## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues for `ian-pascoe/pi-extensions`. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles map directly to same-named GitHub labels. See `docs/agents/triage-labels.md`.

### Domain docs

This repository uses multi-context domain documentation organized by package. See `docs/agents/domain.md`.

## Reference repositories

A local `pnpm install` materializes these read-only references in `.repos/`; CI skips them.
Run `./scripts/sync-reference-repos.sh` to refresh them directly.

| Repository                                                    | Path              | Useful for                                                                                           |
| ------------------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------- |
| [`earendil-works/pi`](https://github.com/earendil-works/pi)   | `.repos/pi`       | Pi extension APIs, lifecycle hooks, tool registration, TUI/runtime behavior, and upstream examples.  |
| [`anomalyco/opencode`](https://github.com/anomalyco/opencode) | `.repos/opencode` | Agent orchestration, tool/plugin architecture, provider/model integration, and terminal UI patterns. |
| [`openai/codex`](https://github.com/openai/codex)             | `.repos/codex`    | Agent-loop, tool protocol, sandbox/approval, MCP integration, and terminal UI implementations.       |
| [`can1357/oh-my-pi`](https://github.com/can1357/oh-my-pi)     | `.repos/oh-my-pi` | Pi-derived LSP/DAP tools, code execution, model prompts, and Rust agent-runtime behavior.            |
