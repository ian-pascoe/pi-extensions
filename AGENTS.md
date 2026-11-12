# `@ian-pascoe/pi-extensions` Instructions

## Working rules

- **SDK compatibility** — Check APIs and package exports against the installed Pi dependency (`node_modules/@earendil-works/pi-coding-agent/dist/core`, and `dist/extensions` for built-in extensions such as codemode; `dist/bundle` is minified) and the package's declared compatibility range. Reference checkouts may be newer than the runtime.
- **Native ownership** — For lifecycle, context, and tool-management changes, trace Pi's existing hooks and local helpers first. Keep policy with its existing owner; implement only the missing behavior.
- **Native state** — Prefer Pi settings for configuration and Pi sessions for durable session state. Minimize external settings files, caches, and other persistence; derive state from Pi where feasible. Introduce external storage only for a concrete need Pi cannot meet, and document that limitation.
- **Coexistence** — When changing tool activation, context delivery, or a package's tool-result text, trace other extensions using the same Pi APIs. Test affected standalone and combined modes: combined-mode tests live in the root `test/` and run with `vp run test:root`, which `vp run --filter` skips.
- **Tool registration** — Register every extension tool through `acceptNullForOptionalArguments` from `@ian-pascoe/pi-utils/null-optional-arguments` so `null` for an optional parameter behaves like omitting it, and cover new tools with `expectNullOptionalArgumentsOmitted` from `@ian-pascoe/pi-utils/tool-testing`. A tool that sets `structuredContent` declares `outputSchema` (codemode scripts get the text otherwise), checked with `expectToolOutputMatches` or a harness's `recordToolOutputs`.
- **Cache proofs** — Prove prefix stability in offline SDK integration tests by comparing the affected ordered tool definitions, system prompt, or message history. Compare across turns, reloads, and modes; equal name sets, token estimates, or a stored literal or hash alone are insufficient.
- **Toolchain** — pnpm installs dependencies; Vite+ (`vp`) runs tests (`vp test`, imported from `vite-plus/test`), formatting and linting (`vp check`, configured in the root `vite.config.ts`), Git hooks (`.vite-hooks/`), and tasks (`vp run <script>`); tsrs is the only typechecker. Run `mise install` for the pinned Node, pnpm, and `vp`, and keep mise active in the shell, since oxlint gets its type-aware backend (tsrslint) from mise's `[env]`. Pin Vite+ toolchain dependencies to concrete versions, never `catalog:`: Pi installs this repository from Git with npm, which rejects catalog specs. `pi-utils` publishes only through `pnpm run publish-packages`. See [ADR 0012](docs/adr/0012-vite-plus-runs-the-toolchain-pnpm-installs.md) and the parts of [ADR 0011](docs/adr/0011-bun-installs-node-runs-npm-publishes.md) it keeps.
- **Verification** — While iterating, run focused checks such as `vp run --filter <package> test`. The pre-push hook runs `vp run verify:push` (format, lint, and typechecks); CI runs the full `vp run verify`, including every test suite, so leave full test runs to CI. Both share a Vite Task cache keyed on the files each step reads, so reruns on unchanged files replay instantly; never bypass the hook with `--no-verify`.
- **PR completion** — Include a Changeset covering every package with releasable changes before opening a PR; test-only package edits need no bump. Follow [docs/releases.md](docs/releases.md) for versioning and release gates.

## Context pointers

- **Tests** — Before writing, changing, or reviewing tests, read [docs/agents/testing.md](docs/agents/testing.md) for what earns a test and how to shape it.
- **Domain docs** — Before exploring, designing, or changing package code, read [docs/agents/domain.md](docs/agents/domain.md) for relevant contexts, vocabulary, and ADRs.
- **Issue tracker** — Before issue or PR tracker operations, read [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md) for Linear conventions and ticket dependencies.
- **Triage** — When triaging issues or applying triage roles, read [docs/agents/triage-labels.md](docs/agents/triage-labels.md) for label mappings.

## Reference repositories

For upstream implementation questions, consult these read-only checkouts. If missing or stale, populate or refresh them with `./scripts/sync-reference-repos.sh`.

| Checkout          | Consult for                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------- |
| `.repos/pi`       | Pi extension APIs, lifecycle, tool registration, TUI/runtime behavior, and examples.                          |
| `.repos/opencode` | Agent orchestration, tool/plugin architecture, provider integration, and terminal UI.                         |
| `.repos/codex`    | Agent loops, tool protocols, sandbox/approval, MCP, TUI, and Context Windows (`features.context_management`). |
| `.repos/oh-my-pi` | Pi-derived LSP/DAP, code execution, model prompts, and Rust agent runtime.                                    |
