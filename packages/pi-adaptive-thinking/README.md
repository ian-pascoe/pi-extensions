<div align="center">

# pi-adaptive-thinking

Bring adaptive reasoning-effort control to Pi agents.

</div>

`pi-adaptive-thinking` is a Pi extension that lets the agent change Pi's thinking level through a tool named `set_thinking_level`.

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

The extension registers a tool with these parameters:

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
  "systemPrompt": "You MUST manage thinking level actively. Lower it before trivial or routine turns; raise it for ambiguity, debugging, risky changes, or multi-step synthesis. Reassess at turn start, after meaningful new evidence, and when the task shifts. NEVER leave the current level unchanged by inertia, and NEVER reply to a trivial turn before considering a downshift."
}
```

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
