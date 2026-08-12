<div align="center">

# pi-adaptive-thinking

Bring adaptive reasoning-effort control to Pi agents.

</div>

`pi-adaptive-thinking` is a Pi extension that lets the agent inspect and change Pi's thinking level through tools named `get_thinking_level` and `set_thinking_level`.

Requires Node `>=22.19.0` and Pi `>=0.84.1`.

It mirrors the user-facing behavior of `opencode-adaptive-thinking` while using Pi-native APIs: `pi.getThinkingLevel()`, `pi.setThinkingLevel()`, and `thinking_level_select`.

## Installation

```bash
pi install npm:pi-adaptive-thinking
```

For local development:

```bash
pnpm install
pi -e ./src/index.ts
```

## Behavior

The extension registers two tools. `get_thinking_level` returns the current native Pi thinking level and the levels supported by the selected model. The agent should inspect status only when the level is uncertain, not poll it every turn.

`set_thinking_level` accepts these parameters:

- `level`: one of the valid Pi thinking levels for the current model.
- `persist`: optional boolean, default `false`.

Temporary changes:

```json
{ "level": "high", "persist": false }
```

This changes thinking level for the current agent turn and restores the prior/baseline level when the turn ends.

Persistent changes:

```json
{ "level": "low", "persist": true }
```

This changes the session baseline until another persistent change is made or the user changes thinking level manually.

The extension contributes only static tool guidance to Pi's base prompt. It never replaces the per-turn system prompt, so current level, supported levels, model, and session state cannot invalidate the system-prompt cache prefix.

## Configuration

Configuration files are loaded in this order:

1. Project: `.pi/adaptive-thinking.json`
2. Global: `~/.pi/agent/adaptive-thinking.json`
3. Built-in defaults

Project configuration takes precedence over global configuration.

```json
{
  "enabled": true,
  "quiet": false,
  "toolName": "set_thinking_level",
  "toolDescription": "Set your thinking level",
  "statusToolName": "get_thinking_level",
  "guidance": "You MUST manage thinking level actively. Lower it before trivial or routine turns; raise it for ambiguity, debugging, risky changes, or multi-step synthesis. Reassess at turn start, after meaningful new evidence, and when the task shifts. NEVER leave the current level unchanged by inertia, and NEVER reply to a trivial turn before considering a downshift."
}
```

`guidance`, tool names, and tool descriptions are loaded once per session and remain static. Do not put runtime state in `guidance`.

The former `systemPrompt` field remains a deprecated alias for `guidance` during the `0.x` release line. Existing configurations continue to work and produce one UI warning at session start unless `quiet` is enabled. A configuration containing both fields is invalid.

## Development

```bash
pnpm install
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
```

Run all checks:

```bash
pnpm verify
```
