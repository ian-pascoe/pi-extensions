# Improve the Pi MCP Observer UI

**Status:** Ready

## Outcome

Give the person supervising a Pi session a compact account of agent MCP activity, actionable MCP Server failures, and current MCP Server health. Add semantic Transcript Presentation, a native footer summary, and reliable read-only command output without changing model-visible MCP content or adding another control surface.

Read before implementation:

- [`../../AGENTS.md`](../../AGENTS.md) for repository instructions.
- [`../../CONTEXT-MAP.md`](../../CONTEXT-MAP.md) and [`../../packages/pi-mcp/CONTEXT.md`](../../packages/pi-mcp/CONTEXT.md) for canonical package language.
- all decisions in [`../../packages/pi-mcp/docs/adr/`](../../packages/pi-mcp/docs/adr/), especially [ADR-0006](../../packages/pi-mcp/docs/adr/0006-separate-observer-presentation-from-model-output-and-command-control.md) for the presentation boundary.
- [`2026-08-24_add-pi-mcp-package.md`](2026-08-24_add-pi-mcp-package.md) for the existing Host, lifecycle, content, and command contracts. This plan supersedes only its lack of semantic human rendering and its `/mcp logs [--level]` behavior.
- [Pi extension tool rendering, custom-message rendering, footer status, and output limits](../../.repos/pi/packages/coding-agent/docs/extensions.md).
- Pi's [interactive tool renderer](../../.repos/pi/packages/coding-agent/src/modes/interactive/components/tool-execution.ts) and [HTML tool renderer](../../.repos/pi/packages/coding-agent/src/core/export-html/tool-renderer.ts) for the two consumers of `renderCall` and `renderResult`.
- [`../../packages/pi-lsp/src/lsp-tool-rendering.ts`](../../packages/pi-lsp/src/lsp-tool-rendering.ts) for native compact and expanded tool rows.
- [`../../packages/pi-dap/src/dap-tool-rendering.ts`](../../packages/pi-dap/src/dap-tool-rendering.ts) for bounded progress, terminal-safe output, and semantic failure states.

Use **MCP Observer UI**, **MCP Observer Snapshot**, **MCP Transcript Presentation**, **MCP Attention Notice**, and **MCP Command Surface** exactly as defined in the package glossary.

## Presentation boundary

Treat the following bytes and data as characterization boundaries:

- final `AgentToolResult.content` from every Server Tool and fixed Resource tool;
- existing Server Tool and fixed Resource tool `details`;
- MCP Prompt custom-message content, details, and role-faithful replay messages;
- Resource Update Notice content and next-turn delivery;
- standalone `list --json` and `test --json` data;
- Server Tool schemas, names, activation, execution, cancellation, and protocol progress.

Presentation derives from existing call arguments, content, details, and live Host status. Add no observer-only field to a persisted tool result, custom message, session entry, JSON result, or RPC payload. Human rendering may apply the existing exact-value settings redactor and strip terminal control sequences from its copy. It must not alter the stored or model-visible bytes and must not guess sensitive fields from names such as `token` or `password`.

The MCP Observer UI reads status already held by the MCP Host. It sends no MCP request and runs no `/mcp` operation. The MCP Command Surface retains authentication, reconnect, configuration, Prompt invocation, subscription, and logging controls. Existing OAuth and elicitation dialogs remain protocol interactions rather than Observer controls.

Semantic tool rendering applies in interactive TUI and HTML exports through Pi's existing renderer hooks. The footer, custom-message renderer, and Attention Notices are TUI-only. Headless, print, JSON, and RPC modes receive no observer-only output. Explicit standalone command text may improve, but its JSON shapes and exit categories remain stable.

Add no catalog browser, command panel, status widget, settings, shortcut, privacy mode, protocol operation, or model tool. Use Pi's theme and expansion state. Add `@earendil-works/pi-tui: "*"` as a peer only because the renderers return Pi TUI components.

## Human presentation contract

### Tool transcript

Every registered Server Tool and fixed Resource tool receives `renderCall` and `renderResult`.

Collapsed calls show one line with:

- `MCP` as the native tool-family label;
- the original MCP Server and Server Tool names, never only the sanitized or collision-hashed Pi name;
- for fixed Resource tools, the semantic operation and selected MCP Server or Resource URI;
- a bounded preview of supplied arguments.

Representative shapes:

```text
MCP  docs / search  query="observer UI"
MCP  List Resources  docs
MCP  Read Resource  docs  file:///guide
```

Collapsed results use symbols and text together:

```text
✓ completed  ·  2 text blocks  ·  1 image
× failed  ·  permission denied
! completed with output-schema failure
```

Use `success`, `warning`, and `error` theme roles only for their matching states. Use muted or dim text for provenance and expansion hints. A Server Tool's `isError` is failure even when content remains available. Output-schema failure is a warning and retains all accompanying content.

Expanded calls show structured input, complete when it fits within Pi's 2,000-line or 50-KB display bounds and clearly truncated otherwise. Expanded results show the bounded model-visible text, content-type counts, stored-content metadata, output-schema outcome, and Result Spill path. Pi continues rendering native result images outside the custom result component. Historical or malformed details fall back to the existing content, with the first useful line collapsed and all bounded text expanded.

Partial progress updates replace the current result row. Show the latest terminal-safe, redacted progress value or `Running…`; final success, failure, or cancellation replaces it. Progress must not append one transcript line per notification.

### Prompt and Resource Update messages

Register TUI message renderers for the existing Prompt and Resource Update custom types.

- Prompt collapsed form shows MCP Server, Prompt name, returned message count, and roles. Expanded form shows bounded role-labelled text and image metadata from the already-persisted replay details. It invokes no Prompt and changes no replay message.
- Resource Update collapsed form shows MCP Server and Resource URI. Expanded form repeats that the Resource remains unread until the agent explicitly reads it. It performs no background read.
- Missing or historical details fall back to the existing custom-message content.

Pi's HTML exporter applies custom tool renderers but not extension custom-message renderers. HTML exports therefore receive semantic Server Tool and Resource tool rows; Prompt and Resource Update entries retain their durable content-based representation. Do not change model-visible custom-message content to fake HTML renderer parity.

### Footer and attention

Use `context.ui.setStatus("pi-mcp", ...)`; add no widget.

- Hide the footer status when no MCP Server is enabled.
- Show a dim connected ratio when all enabled Servers are healthy, for example `MCP 3/3`.
- Add text for connecting, retrying, authentication, client registration, or failed counts when health is degraded.
- Reinforce every color with a state word or count.

Emit one MCP Attention Notice when a condition first becomes actionable:

| Condition                   | Required action           |
| --------------------------- | ------------------------- |
| invalid MCP settings        | `/mcp status`             |
| `needs_auth`                | `/mcp auth <server>`      |
| `needs_client_registration` | `/mcp auth <server>`      |
| terminal `failed`           | `/mcp reconnect <server>` |

Each notice includes the MCP Server when one exists, the exact-value-redacted cause, and the command. Connecting, retrying, connected, disabled, and successful recovery update only the footer. Deduplicate identical actionable status within one session. Clear footer ownership before Host shutdown so intentional teardown cannot create attention.

## Command contract

The explicit MCP Command Surface supports diagnosis after a footer or Attention Notice points the human there.

- `/mcp help` returns the same concise runtime help appended by bare `/mcp`.
- `/mcp status` distinguishes invalid settings from an empty configuration. For each MCP Server it shows state, redacted cause, connection or retry attempt, retry timing, and active Resource subscriptions. Sort Servers and subscription URIs deterministically.
- `list` human output includes the already-returned effective fields: provenance, enabled or masked state, transport, auth type, and stored-auth presence. Preserve `list --json` data exactly.
- `logs [server]` is a read-only view. Remove `--level` from the command type, parser, usage, Host read path, tests, and README. Do not repurpose it as a filter because retained stderr has no severity.
- Bound combined log output to Pi's 2,000-line or 50-KB limit while keeping the newest text. When truncation occurs, identify the private retained-log path that contains the complete 256-KB server tail.
- Convert expected live Host failures into specific redacted adapter failures. Keep the generic `command failed unexpectedly` fallback for unknown exceptions so unexpected values cannot leak secrets.
- Keep human-readable output consistent between `/mcp` and standalone `pi-mcp` wherever they share an operation. Preserve JSON shapes, process exit codes, and standalone/runtime availability.

## Intended module changes

| File                                    | Responsibility                                                                                                    |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `src/mcp-presentation.ts`               | Existing-detail parsing, terminal-safe bounded previews, tool call/result renderers, and custom-message renderers |
| `src/mcp-observer-ui.ts`                | Pure health projection plus the TUI footer, Attention Notice deduplication, and disposal                          |
| `src/mcp-tool-catalog.ts`               | Attach renderers to dynamic Server Tools and fixed Resource tools while preserving execution and final content    |
| `src/mcp-host.ts`                       | Publish status observation, list active subscriptions, and make log reads side-effect free                        |
| `src/mcp-session-files.ts`              | Return the private retained-log path with bounded log reads                                                       |
| `src/mcp-command.ts`                    | Add runtime help, remove log-level grammar, preserve stable execution results                                     |
| `src/pi-mcp-cli.ts`                     | Render complete effective Server Definition summaries while preserving JSON data                                  |
| `src/pi-mcp-extension.ts`               | Wire presentation, status observation, redaction, custom messages, richer live commands, and lifecycle cleanup    |
| focused package tests                   | Characterize model content; cover transcript, footer, messages, status, commands, width, fallback, and cleanup    |
| `package.json` and `pnpm-lock.yaml`     | Add the Pi TUI peer dependency                                                                                    |
| `CONTEXT.md`, ADR-0006, and `README.md` | Record terminology, boundaries, and shipped human behavior                                                        |
| `.changeset/*.md`                       | Minor release note for semantic Observer UI and the removed `logs --level` option                                 |

Keep presentation types beside `mcp-presentation.ts`. Add no generic renderer interface, event bus, store, alternate view abstraction, or shared `ui-utils.ts`.

## Implementation sequence

### 1. Freeze model and command data before adding presentation

Record the baseline:

```bash
git status --short
git rev-parse HEAD
pnpm --filter @ian-pascoe/pi-mcp typecheck
pnpm --filter @ian-pascoe/pi-mcp test
```

Add exact characterization assertions for:

- successful, MCP-error, and output-schema-failure Server Tool `content`;
- each fixed Resource tool's `content`;
- partial progress followed by final content;
- Prompt custom-message content and transformed replay messages;
- Resource Update Notice content and `nextTurn` delivery;
- standalone `list --json` and `test --json` output.

Move the existing MCP result marker schema/parser and Prompt replay-detail parser into `mcp-presentation.ts` so rendering and existing consumers share one boundary parser. Preserve their accepted shapes and every detail field so the `tool_result` bridge, Prompt replay, and RPC data remain stable. Leave subscription persistence parsing in `pi-mcp-extension.ts`; it is not presentation. Add the Pi TUI peer dependency.

**Complete when:** focused tests prove every characterized value is byte-identical, malformed or unknown existing details fall back safely, and package typecheck remains green.

### 2. Build semantic tool rendering test-first

Create `test/mcp-presentation.test.ts` with a plain theme and fixed-width component helper. Cover:

- dynamic Server Tool calls using original MCP Server and Server Tool identities even when the Pi name is sanitized or collision-hashed;
- all three fixed Resource operations;
- deterministic scalar, nested, empty, and oversized argument previews;
- collapsed success, MCP error, output-schema warning, cancellation, empty content, text, image, structured content, stored binary/audio metadata, and Result Spill states;
- expanded structured arguments and bounded result text;
- exact-value redaction in the presentation copy without changing input, content, or details;
- CSI, OSC, APC, C0, and C1 removal from presentation copy while preserving normalized line breaks and tabs;
- partial progress updating the existing row;
- native expansion hints, theme-only styling, and useful historical or malformed-detail fallback; and
- rendered lines fitting narrow terminal widths through Pi TUI width helpers.

Wire the pure renderers into every definition created by `McpToolCatalog`. Reuse Pi's `keyText("app.tools.expand")`, `truncateHead`, `visibleWidth`, `sliceByColumn`, and `truncateToWidth`; add no handwritten ANSI or width counting.

Use transient state keyed by `ToolRenderContext.toolCallId` only when the final Pi error content cannot distinguish cancellation from failure. Clear it when the final result renders and when the session closes. Persist no presentation state; HTML export falls back to the characterized final content when transient state is absent.

Add one real Pi HTML export assertion proving a registered MCP tool uses the same collapsed and expanded renderer while stored tool call/result data remains unchanged.

**Complete when:** every MCP tool has a compact semantic row, expanded data stays bounded, final model content remains characterized, and TUI plus HTML rendering tests are green.

### 3. Render Prompt and Resource Update messages

Derive Prompt presentation from its existing version-1 replay details and content label. Derive Resource Update presentation from its existing content. Register both renderers during inert extension registration, with a session-owned redactor available through the active lifecycle controller rather than persisted presentation data.

Test collapsed, expanded, text, image metadata, mixed roles, oversized text, exact-value redaction, terminal controls, historical details, malformed details, and rendering before an active session exists.

Assert the existing `context` hook produces the same role-faithful messages from old and enriched details. Assert Resource Update rendering performs no Host read and does not trigger another model turn.

**Complete when:** Prompt and Resource Update entries are useful in the TUI, historical sessions retain their fallback, and replay or model-delivery tests show no semantic change.

### 4. Publish Host status and build the Observer footer

First add Host tests for a synchronous, failure-isolated status observer. Publish one copied, sorted status map after every status assignment and after structural entry changes. Route assignments through one private setter; publish explicitly after add, replacement, and removal so deletion cannot leave a stale footer. The observer never receives a mutable entry.

Add a deterministic `listSubscriptions()` read that returns copied, sorted `{ serverId, uri }` values. It must perform no protocol request.

Drive `mcp-observer-ui.ts` with fake contexts and clocks. Cover:

- no enabled Servers, all connected, connecting, mixed health, retrying, authentication, registration, and terminal failure;
- dim healthy summary and text-backed warning/error summaries;
- one notice per actionable status, no notice for routine states, and re-notification only after the actionable condition materially changes;
- invalid settings using `/mcp status` as its action;
- exact redaction and terminal-safe notice text;
- TUI operation, inert RPC/headless behavior, footer clearing, and idempotent disposal; and
- a throwing UI callback leaving Host lifecycle, retry, and cleanup unchanged.

Construct one observer owner per Pi session. Dispose it before `host.shutdown()` on reload and `session_shutdown`.

**Complete when:** all Host transitions update one bounded footer projection, actionable states notify once with the right command, and observer failure cannot change a Host test's status or protocol request log.

### 5. Repair read-only command output

Update grammar and command tests before adapters:

- `/mcp help` succeeds and dispatches no adapter;
- `logs [server]` accepts no options;
- `logs --level warning` returns usage failure;
- existing standalone/runtime command availability remains unchanged; and
- unexpected adapter exceptions retain the generic safe failure.

Then update live and standalone adapters:

- status includes invalid settings, all status-specific fields, and sorted active subscriptions;
- list text includes every field already present in its stable JSON data;
- expected unknown-server, disconnected, unsupported-capability, Prompt, subscription, reconnect, and log failures retain their redacted cause and category;
- log reads call no logging-level operation, show newest bounded output, and name the full retained path when truncated; and
- combined output remains within Pi's standard line and byte limits across multiple Servers.

Remove the now-unused logging-level command types and Host read side effect. Remove an internal `setLoggingLevel` wrapper if it has no remaining caller; receiving MCP logging notifications remains supported.

Correct the existing documentation contradiction: invalid settings appear in `/mcp status` instead of being reported as an empty configuration.

**Complete when:** command parser, shared executor, Host, CLI, extension, and real-file tests pass; JSON and exit contracts are unchanged; and reading logs cannot call an MCP Server method.

### 6. Integrate, document, and verify

Update `packages/pi-mcp/README.md` with:

- compact and expanded Server Tool, Resource, Prompt, and Resource Update presentation;
- footer health and actionable Attention Notices;
- TUI, HTML export, headless, JSON, and RPC boundaries;
- richer `status`, `list`, `help`, subscriptions, and bounded logs;
- removal of `logs --level`; and
- exact-value redaction versus faithful arbitrary Server Tool data.

Retain the implementation-free glossary wording and ADR-0006. Add a minor Changeset for `@ian-pascoe/pi-mcp` that calls out semantic human presentation and the removed log-level side effect. Do not edit the package version directly.

Run focused checks after each slice, then:

```bash
pnpm format
pnpm --filter @ian-pascoe/pi-mcp typecheck
pnpm --filter @ian-pascoe/pi-mcp test
pnpm pack:check
pnpm verify
pnpm changeset:status
git diff --check
git status --short
```

Smoke-test the installed extension in a real Pi TUI:

1. start with no enabled MCP Server and confirm no MCP footer status;
2. enable the configured Everything Server and confirm connecting then healthy footer states;
3. run one Server Tool, one fixed Resource tool, and one Prompt, then inspect collapsed and expanded rows;
4. export the session to HTML and confirm semantic Server Tool and Resource tool rows;
5. trigger progress and confirm one row updates in place;
6. configure a failing Server and confirm footer degradation, one actionable notice, redacted cause, and useful `/mcp status` output;
7. subscribe to a Resource, reload, and confirm `/mcp status` lists the restored subscription;
8. run `/mcp logs`, confirm bounded newest output, then prove the Server received no logging-level request; and
9. run under RPC or print mode and confirm no footer, message renderer, or Attention Notice entered output.

**Complete when:** every automated check passes, the nine smoke checks pass, the tarball contains the new source modules, the Changeset is valid, and no model-visible MCP content, JSON shape, or protocol request changed.

## Acceptance checklist

- [ ] Server Tool and fixed Resource tool calls have native compact and expanded rendering.
- [ ] Original MCP Server and Server Tool identities remain visible after Pi-name sanitization or collision hashing.
- [ ] Progress updates one row; success, failure, warning, and cancellation are text-backed and theme-correct.
- [ ] Expanded observer copy is bounded, terminal-safe, and exact-value-redacted while model bytes remain unchanged.
- [ ] Pi continues rendering native result images and complete oversized content remains available through Result Spills.
- [ ] Prompt and Resource Update messages render semantically in TUI without changing replay or next-turn delivery.
- [ ] HTML exports use semantic tool rendering; custom messages retain content-based export fallback.
- [ ] A native footer shows enabled MCP Server health and no widget exists.
- [ ] Actionable settings, authentication, registration, and terminal failures notify once with the exact command.
- [ ] `/mcp help`, status details, active subscriptions, complete list text, and actionable failures work.
- [ ] `/mcp logs` is bounded and read-only; `--level` and its Host side effect are gone.
- [ ] Standalone JSON shapes, exit codes, model tools, Prompt replay, Resource Update content, and Server Tool `content` are unchanged.
- [ ] TUI lifecycle, headless/RPC inertness, HTML export, historical fallback, narrow width, reload, and cleanup tests pass.
- [ ] README, glossary, ADR, plan, and Changeset agree with shipped behavior.
- [ ] `pnpm verify`, package tests, pack check, and the live TUI smoke test pass.

## Pause

Do not begin implementation until the user explicitly approves it in a later turn.
