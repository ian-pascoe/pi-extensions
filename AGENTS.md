# `@ian-pascoe/pi-extensions` Instructions

## Working rules

- **SDK compatibility** — Check APIs and package exports against the installed Pi dependency (`node_modules/@earendil-works/pi-coding-agent/dist/core`; `dist/bundle` is minified) and the package's declared compatibility range. Reference checkouts may be newer than the runtime.
- **Native ownership** — For lifecycle, context, and tool-management changes, trace Pi's existing hooks and local helpers first. Keep policy with its existing owner; implement only the missing behavior.
- **Native state** — Prefer Pi settings for configuration and Pi sessions for durable session state. Minimize external settings files, caches, and other persistence; derive state from Pi where feasible. Introduce external storage only for a concrete need Pi cannot meet, and document that limitation.
- **Coexistence** — When changing tool activation, context delivery, or a package's tool-result text, trace other extensions using the same Pi APIs. Test affected standalone and combined modes: combined-mode tests live in the root `test/` and run with `bun run test:root`, which `bun run --filter` skips.
- **Tool registration** — Register every extension tool through `acceptNullForOptionalArguments` from `@ian-pascoe/pi-utils/null-optional-arguments` so `null` for an optional parameter behaves like omitting it, and cover new tools with `expectNullOptionalArgumentsOmitted` from `@ian-pascoe/pi-utils/tool-testing`.
- **Cache proofs** — Prove prefix stability in offline SDK integration tests by comparing the affected ordered tool definitions, system prompt, or message history. Equal name sets or token estimates alone are insufficient.
- **Toolchain** — Bun installs dependencies and runs package scripts; Node runs the tools behind them (Vitest, the repository scripts, Changesets, Pi), and npm publishes. Keep Node 22.19 on `PATH` (`mise install`), run scripts with `bun run <script>`, and never use `bun test`, `bun --bun`, or `bun publish`: the repository scripts and `vitest.config.ts` refuse to run under Bun. `pi-utils` publishes only through `bun run publish-packages`, because npm ignores `publishConfig` field overrides. See [ADR 0011](docs/adr/0011-bun-installs-node-runs-npm-publishes.md).
- **Verification** — While iterating, run focused checks such as `bun run --filter <package> test`. The pre-push hook runs `bun run verify:push` (format, lint, and typechecks); CI runs the full `bun run verify`, including every test suite, so leave full test runs to CI. Both share a Turborepo cache keyed on file contents, so reruns on unchanged files replay instantly; never bypass the hook with `--no-verify`.
- **PR completion** — Include a Changeset covering every package with releasable changes before opening a PR; test-only package edits need no bump. Follow [docs/releases.md](docs/releases.md) for versioning and release gates.

## Context pointers

- **Domain docs** — Before exploring, designing, or changing package code, read [docs/agents/domain.md](docs/agents/domain.md) for relevant contexts, vocabulary, and ADRs.
- **Issue tracker** — Before issue or PR tracker operations, read [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md) for GitHub conventions and ticket dependencies.
- **Triage** — When triaging issues or applying triage roles, read [docs/agents/triage-labels.md](docs/agents/triage-labels.md) for label mappings.

## Reference repositories

For upstream implementation questions, consult these read-only checkouts. If missing or stale, populate or refresh them with `./scripts/sync-reference-repos.sh`.

| Checkout          | Consult for                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------- |
| `.repos/pi`       | Pi extension APIs, lifecycle, tool registration, TUI/runtime behavior, and examples.                          |
| `.repos/opencode` | Agent orchestration, tool/plugin architecture, provider integration, and terminal UI.                         |
| `.repos/codex`    | Agent loops, tool protocols, sandbox/approval, MCP, TUI, and Context Windows (`features.context_management`). |
| `.repos/oh-my-pi` | Pi-derived LSP/DAP, code execution, model prompts, and Rust agent runtime.                                    |
