<div align="center">

<h1>pi-byterover</h1>

<p>Bring ByteRover memory to Pi agents with automatic recall and persistence.</p>

<p>
  <a href="https://www.npmjs.com/package/pi-byterover"><img src="https://img.shields.io/npm/v/pi-byterover?style=for-the-badge&color=5B8DEF" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/npm/l/pi-byterover?style=for-the-badge&color=34D399" alt="license"></a>
  <a href="https://github.com/ian-pascoe/pi-extensions/tree/main/packages/pi-byterover"><img src="https://img.shields.io/badge/github-pi--extensions-111827?style=for-the-badge&logo=github" alt="GitHub repository"></a>
</p>

</div>

`pi-byterover` connects Pi sessions to ByteRover through `@byterover/brv-bridge`.

It automatically recalls relevant ByteRover memory before an agent response and injects that context into the session. After useful completed turns, it persists durable facts, decisions, preferences, and technical details back to ByteRover.

Recalled memory is framed as **untrusted reference material**. The extension tells the agent not to treat recalled text as system, developer, user, or tool instructions.

## Prerequisites

- Pi installed.
- Node `>=22.19.0` and Pi `>=0.84.1`.
- ByteRover CLI installed as `brv`, or a custom executable path configured with `brvPath`.
- A project where ByteRover can bootstrap and use `.brv` state.

## Installation

Install the package with Pi:

```bash
pi install npm:pi-byterover
```

For local development:

```bash
pnpm install
pnpm --filter pi-byterover test
pi -e ./src/index.ts
```

## Configuration

Configure `pi-byterover` with either a project config file or a global config file:

- Project: `.pi/byterover.json`
- Global: `~/.pi/agent/byterover.json`

Project configuration takes precedence over global configuration. If no config file is present, defaults are used.

```json
{
  "enabled": true,
  "brvPath": "brv",
  "searchTimeoutMs": 30000,
  "recallTimeoutMs": 30000,
  "persistTimeoutMs": 60000,
  "quiet": false,
  "autoRecall": true,
  "autoPersist": true,
  "manualTools": true,
  "contextTagName": "byterover-context",
  "recallPrompt": "Recall any relevant context that would help answer the latest user message.\nUse the recent conversation only to resolve references and intent.\nDo not restate the query in your findings.",
  "persistPrompt": "The following is a conversation between a user and an AI assistant.\nCurate only information with lasting value: facts, decisions, technical details, preferences, or notable outcomes.\nSkip trivial messages such as greetings, acknowledgments (\"ok\", \"thanks\", \"sure\", \"got it\"), one-word replies, anything with no substantive content.",
  "maxRecallTurns": 3,
  "maxRecallChars": 4096
}
```

Configuration fields:

- `enabled`: Enable or disable the package without removing configuration. Defaults to `true`.
- `brvPath`: ByteRover CLI executable path. Defaults to `brv`.
- `searchTimeoutMs`: ByteRover search timeout in milliseconds. Defaults to `30000`.
- `recallTimeoutMs`: ByteRover recall timeout in milliseconds. Defaults to `30000`.
- `persistTimeoutMs`: ByteRover persist timeout in milliseconds. Defaults to `60000`.
- `quiet`: Suppress Pi notifications for ByteRover operations. Defaults to `false`.
- `autoRecall`: Automatically recall and inject ByteRover context before agent responses. Defaults to `true`.
- `autoPersist`: Automatically persist useful completed conversation turns after responses. Defaults to `true`.
- `manualTools`: Register manual ByteRover tools. Defaults to `true`.
- `contextTagName`: XML-style tag name used for injected recall context. Defaults to `byterover-context`.
- `recallPrompt`: Instruction text prepended to recent conversation context for automatic recall.
- `persistPrompt`: Instruction text prepended to completed turns for automatic persistence curation.
- `maxRecallTurns`: Maximum recent user turns used to resolve automatic recall context. Defaults to `3`.
- `maxRecallChars`: Maximum recent conversation characters used for automatic recall. Defaults to `4096`.

Numeric timeout and limit values must be positive integers. `brvPath`, `recallPrompt`, and `persistPrompt` must be non-empty strings. `contextTagName` must be a simple XML-style tag name such as `byterover-context`.

Persist does not require ByteRover to be ready ahead of time. ByteRover bootstraps automatically when persist is called.

## Manual Tools

When `manualTools` is enabled, Pi agents can use these ByteRover tools:

- `brv_recall`: Ask ByteRover to synthesize relevant memory for a query. Use it when the agent needs targeted, summarized context beyond automatic recall. Accepts optional `timeoutMs`.
- `brv_search`: Search ByteRover memory and return ranked file-level results. Use it when the agent needs to inspect matching memory sources or compare multiple candidates. Accepts optional `limit`, `scope`, and `timeoutMs`.
- `brv_persist`: Persist raw memory text directly into ByteRover. Use it when a durable fact, decision, preference, or technical detail should be saved immediately instead of waiting for automatic turn persistence. Defaults to fire-and-forget mode and accepts optional `timeoutMs` for long-running writes.

With `autoRecall` and `autoPersist` enabled, routine memory behavior is automatic. Manual tools are best for explicit lookups, source searches, or immediate saves.

## Development

```bash
pnpm install
pnpm format:check
pnpm lint
pnpm --filter pi-byterover test
pnpm --filter pi-byterover typecheck
```
