# Improve the Pi DAP Observer UI

**Status:** Ready

## Outcome

Give a human watching Pi a compact, live account of the agent's Debug Session without changing
what the `dap` tool gives the model. Add semantic transcript rendering and one active-session
widget. Keep Pi DAP a model-operated debugger: the Observer UI displays activity but never sends a
DAP request or provides human debugger controls.

Read before implementation:

- [`../../AGENTS.md`](../../AGENTS.md)
- [`../../CONTEXT-MAP.md`](../../CONTEXT-MAP.md)
- [`../../packages/pi-dap/CONTEXT.md`](../../packages/pi-dap/CONTEXT.md)
- [`../../packages/pi-dap/docs/adr/0001-own-a-narrow-dap-client.md`](../../packages/pi-dap/docs/adr/0001-own-a-narrow-dap-client.md)
- [`2026-08-18_add-pi-dap-package.md`](2026-08-18_add-pi-dap-package.md)
- Pi LSP's transcript pattern in
  [`../../packages/pi-lsp/src/lsp-tool-rendering.ts`](../../packages/pi-lsp/src/lsp-tool-rendering.ts)
- Minimal Subagents' rendering, progress, and widget patterns in
  [`../../packages/pi-minimal-subagents/src/minimal-subagents-rendering.ts`](../../packages/pi-minimal-subagents/src/minimal-subagents-rendering.ts),
  [`../../packages/pi-minimal-subagents/src/minimal-subagents-tools.ts`](../../packages/pi-minimal-subagents/src/minimal-subagents-tools.ts), and
  [`../../packages/pi-minimal-subagents/src/minimal-subagents-ui.ts`](../../packages/pi-minimal-subagents/src/minimal-subagents-ui.ts)

Use the Pi DAP glossary's **Observer UI** and **Observer snapshot** terms. Do not call this surface a
debugger UI, panel, or Debug Session state.

This plan supersedes only the prior bootstrap plan's “no widget or custom rendering” boundary. The
prior plan's model-facing operations, protocol, process, settings, output, publishing, and debugger
panel boundaries remain authoritative.

## Non-negotiable boundary

The final `AgentToolResult.content` contract is a characterization boundary:

- Preserve the existing raw `DAP <operation>: <JSON>` text, Debuggee output, 2,000-line/50-KB
  truncation, and Result Spill notice exactly.
- Keep the existing model-facing operation schemas and twelve operations unchanged.
- `renderCall`, `renderResult`, partial `onUpdate` values, and the widget are presentation. They may
  add bounded typed `details`, but they must not replace, summarize, sanitize, or reorder the final
  agent-facing text.
- Sanitize only the Observer UI copy of Debuggee output with Pi TUI's
  `stripTerminalSequences`, then remove remaining C0/C1 controls except normalized line breaks and
  tabs. The raw tool text and Result Spill retain the original output.
- The Observer UI may project tool arguments, successful results, and DAP events already received.
  It sends no hidden stack, scopes, variables, evaluation, threads, or status request.

The feature remains source TypeScript. Add no build output, command, shortcut, footer status,
custom debugger panel, persistence, adapter behavior, or new model-facing operation. Because this
work extends the still-unreleased bootstrap package on its existing PR, add no Changeset.

## Observer contract

### Transcript

Use Pi's supplied theme and native collapsed/expanded state.

Collapsed calls are one semantic line:

```text
DAP  Launch  node · app.ts
DAP  Set breakpoints  app.ts · 3
DAP  Variables  frame #14
```

Collapsed final results report the operation's meaning rather than generic success:

```text
● stopped · breakpoint
✓ 3 breakpoints verified
14 stack frames · app.ts:42
result = 42 · number
■ terminated · exit 0
```

Use symbols and text together:

| Meaning              | Presentation |
| -------------------- | ------------ |
| Running              | `▶ running`  |
| Stopped              | `● stopped`  |
| Verified/completed   | `✓`          |
| Terminated           | `■`          |
| Warning/cancellation | `!`          |
| Failure              | `×`          |

Use theme colors only. A normal breakpoint stop is accent state, not a warning. Reserve warning and
error colors for actual warnings and failures.

Expanded calls show every explicitly supplied tool argument as labeled fields. Do not reveal the
effective inherited environment or settings not present in the call. Bound multiline argument and
expression previews. Render workspace paths relative to the Pi working directory; retain absolute
paths only when they are outside it.

Expanded results show:

- state, adapter/profile, stop reason, and termination information when applicable;
- verified and unverified Breakpoints with messages;
- Stack Frames with subdued IDs, names, and source locations;
- variable groups or variables with values, types, and subdued references;
- evaluation value, type, and variables reference;
- discarded-output warnings, truncation state, and Result Spill path;
- sanitized Debuggee output when the visible final content still contains its output section.

Render at most 20 rows in each structured section and state the omitted count. Do not repeat the raw
JSON heading in expanded mode. Historical, malformed, or missing details fall back to the original
tool text: first actionable line while collapsed, full text while expanded.

For `launch`, `continue`, `next`, `step_in`, and `step_out`, call `onUpdate` immediately and once per
second until the operation settles. Partial rows contain the humanized operation and elapsed time,
for example `Continuing… 7s`. Use an unref'ed interval and clear it in `finally`. The final tool
result remains the existing raw result.

When an execution wait is cancelled but the Debug Session remains live, final details must let the
renderer say both facts, for example:

```text
! continue wait cancelled · Debug Session still running
```

### Widget

Mount one `pi-dap` widget above the editor when launch begins. It is inert outside TUI mode. Render
one line whose wide form is:

```text
DAP  ● stopped · breakpoint  node/node  app.ts:42  18s
```

The path slot shows the current source location after a successful result has supplied one during the
current stopped epoch; otherwise it shows the explicitly launched program when available.

Degrade right-to-left as width shrinks:

1. remove duration;
2. remove source location or program;
3. remove profile/adapter;
4. remove stop reason;
5. truncate only after preserving `DAP` and the state label where width allows.

Every rendered line must fit its terminal width, including widths 80, 55, 39, and 20. Use Pi TUI's
`visibleWidth`, `sliceByColumn`, and `truncateToWidth`; do not hand-count ANSI strings.

Observer snapshots update on actual lifecycle transitions, including while a tool call is still
waiting. Stable launch context may include adapter, profile, explicitly supplied program, and launch
time. Stop-specific context—reason, thread, frame, and source location—belongs to one stopped epoch:
clear it immediately on resume. A source location appears only after a successful tool result has
already supplied it.

There is no idle widget. Preserve a terminated snapshot for 10 seconds, then remove it. A new launch
cancels the prior terminal cooldown before updating or remounting the widget. Reload and session
shutdown dispose it immediately. Normal stops, resumes, and termination do not notify. Keep settings
warnings and notify only an actionable asynchronous adapter/session failure that is not already
represented by an active tool result.

## Data and ownership

### Tool render contract

Move the public tool input and result schemas from `dap-tool.ts` into a specific
`dap-tool-contract.ts`. This avoids a runtime import cycle between execution and rendering and gives
historical transcript parsing one source of truth. Keep the existing fields and add only optional,
bounded Observer presentation details.

Use an operation-specific presentation union rather than a bag of optional fields. It needs variants
only for data that the existing compact details cannot render:

- Breakpoint rows plus omitted count;
- Stack Frame rows, total count, plus omitted count;
- variable-group/variable rows plus omitted count;
- evaluation value/type/reference;
- execution-wait cancellation.

Keep progress details as a separate discriminated variant containing operation and elapsed time. The
tool definition may accept the final/progress details union for rendering, but every returned final
result must still validate against the final-result schema; progress details exist only in
`onUpdate`.

Build these details from the already-returned `DapSessionResult`. Cap presentation rows while creating
details; never copy an unbounded variables result into `details`. Read Debuggee output from the final
visible text only, so details do not duplicate up to 1 MiB of retained output.

### Debug Session observation

Keep protocol/session authority in `DapSession`. Add optional construction callbacks for:

- lifecycle snapshot changes; and
- unexpected adapter/protocol failure.

Publish the existing `DapSessionSnapshot` after each real state mutation: launching, running before an
execution request waits, stopped, terminated, and idle after a failed pre-launch startup. Publishing
is synchronous observation and performs no protocol work. Do not let a UI callback failure break
session cleanup; either make the lifecycle-owned callback non-throwing or isolate it at the boundary.

### UI controller

Add a lifecycle-owned `DapObserverUiController`. It owns:

- the current non-authoritative Observer snapshot;
- one mounted widget component;
- launch start time and explicit program path;
- current stopped-epoch location learned from successful tool results;
- active DAP tool-call count, used to suppress duplicate asynchronous-failure notifications;
- the one-second render refresh while duration is visible;
- the 10-second terminal cooldown; and
- idempotent disposal.

Give `dap-tool.ts` a narrow observer dependency with start, success, and failure hooks. The tool uses
it only to maintain presentation context; operation dispatch and final output creation remain
independent. The lifecycle controller constructs the UI controller at `session_start`, wires session
callbacks and tool hooks to it, and disposes it before shutting down the Debug Session during reload
or `session_shutdown`.

## Intended module changes

| File                                       | Responsibility                                                                |
| ------------------------------------------ | ----------------------------------------------------------------------------- |
| `src/dap-tool-contract.ts`                 | Public input/details schemas and bounded operation-specific presentation DTOs |
| `src/dap-tool-rendering.ts`                | Pure transcript call/result rendering and output sanitization                 |
| `src/dap-observer-ui.ts`                   | Observer projection, responsive widget, timers, notifications, and disposal   |
| `src/dap-tool.ts`                          | Dispatch, unchanged raw output, progress updates, and observer hooks          |
| `src/dap-session.ts`                       | Publish existing lifecycle snapshots and unexpected failures                  |
| `src/pi-dap-extension.ts`                  | Construct, wire, and dispose the Observer UI                                  |
| `test/dap-tool-rendering.test.ts`          | Collapsed, expanded, partial, fallback, sanitization, and row-cap behavior    |
| `test/dap-observer-ui.test.ts`             | Projection, responsive widget, cooldown, notifications, and cleanup           |
| existing DAP tests                         | Raw-output characterization, session observation, lifecycle, and integration  |
| `package.json` / `pnpm-lock.yaml`          | Add wildcard `@earendil-works/pi-tui` peer dependency                         |
| `CONTEXT.md`, ADR, and package `README.md` | Canonical terms and the Observer/direct-operation boundary                    |

No generic `ui-types.ts`, `render-utils.ts`, event bus, store, framework, or alternate renderer
abstraction is needed.

## Implementation sequence

### 1. Freeze the agent-facing output and extract the tool contract

Before moving code, add characterization assertions to `test/dap-tool.test.ts` for exact final
`content` in these cases:

- an ordinary successful result with no Debuggee output;
- a result with Debuggee output and discarded-byte notice;
- a truncated result with its exact Result Spill notice; and
- a cancelled execution wait whose final raw content remains the current session JSON.

Move the existing input/details schemas and types to `dap-tool-contract.ts`, update imports, and keep
all characterization tests green. Add the bounded presentation union without changing required
legacy details fields. Add `@earendil-works/pi-tui: "*"` beside the existing peers.

**Complete when:** package typecheck passes, existing tool tests pass, and exact final text tests prove
the extraction and new details have not changed `AgentToolResult.content`.

### 2. Build the transcript renderer test-first

Create `test/dap-tool-rendering.test.ts` with a plain theme and fixed-width render helper, following
Pi LSP. Drive `dap-tool-rendering.ts` through:

- representative collapsed calls for all twelve operation branches;
- expanded explicit arguments, bounded multiline values, and workspace-relative paths;
- every state symbol and operation-specific final summary;
- Breakpoint, Stack Frame, variables, and evaluation expanded sections;
- IDs hidden when collapsed and visible when expanded;
- 20-row caps and omitted counts;
- partial elapsed updates;
- cancellation plus retained Debug Session state;
- discarded/truncated output and spill metadata;
- ANSI, CSI, OSC, and APC removal from human-visible Debuggee output while the original result
  object remains unchanged;
- remaining C0/C1 controls removed while preserving normalized line breaks and tabs; and
- error, missing-details, malformed-details, and historical fallback.

Wire `renderCall` and `renderResult` into the one `dap` definition. Use Pi's native expansion hint
(`keyText("app.tools.expand")`) and supplied `Theme`; add no hardcoded ANSI.

**Complete when:** focused renderer and tool tests pass, every operation has a semantic collapsed
form, expanded output is bounded, and malformed historical results still render useful original
text.

### 3. Publish lifecycle snapshots without changing DAP behavior

Add red tests in `test/dap-session.test.ts` using the existing fake adapter seam. Assert snapshot
observation for launch, immediate resume, stop, natural termination, explicit stop, failed startup,
and unexpected adapter failure. Assert stop-specific presentation inputs cannot survive the running
transition and that observing produces no additional DAP requests.

Implement the optional callbacks at the smallest shared state-mutation points in `DapSession`.
Preserve current cleanup ordering, execution wait semantics, protocol requests, and public operation
results. Add Observer assertions to the existing real `vscode-js-debug` integration rather than
creating another integration fixture.

**Complete when:** focused session and real-adapter tests pass, observed transitions match actual
session transitions, and the fake adapter request log is unchanged apart from existing operations.

### 4. Build the widget projection and controller test-first

Create `test/dap-observer-ui.test.ts` with fake timers, a passthrough theme, and TUI/RPC contexts.
Cover:

- the wide one-line hierarchy and exact degradation order at 80, 55, 39, and 20 columns;
- every line satisfying `visibleWidth(line) <= width`;
- launch mounting, one refresh interval, in-place component updates, and render invalidation;
- stopped-epoch location retention and immediate clearing on running;
- no idle widget;
- exactly 10 seconds of terminated cooldown;
- a new launch during cooldown cancelling the old timeout so it cannot hide the active widget;
- reload/shutdown disposal clearing interval, timeout, and widget idempotently;
- RPC-mode inertness; and
- notifications only for unexpected failure with no active DAP tool call.

Implement `dap-observer-ui.ts` from the Minimal Subagents controller pattern, omitting its footer and
multi-row hierarchy machinery. Refresh on every observed state/tool transition; use the interval only
for elapsed-duration repainting.

**Complete when:** focused UI tests pass with fake timers, the controller owns every resource it
creates, and terminal-width assertions hold at all four widths.

### 5. Wire tool activity, partial progress, and extension lifecycle

Extend `test/dap-tool.test.ts` with fake-timer tests that capture `onUpdate`: immediate update, one
update per second, humanized operation, increasing elapsed time, unref'ed/cleared interval, and no
progress interval for immediate inspection/status operations. Record cancellation in bounded
presentation details while retaining the exact final content.

Extend `test/pi-dap-extension.test.ts` to exercise a TUI context and verify:

- one tool and one UI controller per Pi conversation session;
- renderer registration through the tool definition;
- settings warnings remain unchanged;
- reload disposes the old widget before creating new session resources;
- concurrent/idempotent shutdown clears widget and timers; and
- RPC mode creates no widget.

Dispose the UI controller before `session.shutdown()` so intentional shutdown cannot create a
cooldown widget or asynchronous-failure notification.

**Complete when:** focused tool/lifecycle tests pass, live updates stop in every success/error/cancel
path, and `/reload` leaves one tool, one current runtime, and no old UI resources.

### 6. Document and verify

Update the existing ADR instead of adding another: clarify that Pi DAP excludes a directly operated
debugger UI while permitting the non-authoritative Observer UI. Update `packages/pi-dap/README.md`
with collapsed/expanded transcript behavior, widget lifecycle, raw model-result preservation,
sanitized human output, and TUI-only behavior. Keep `CONTEXT.md` implementation-free.

Run after each focused slice:

```bash
pnpm --filter @ian-pascoe/pi-dap typecheck
pnpm --filter @ian-pascoe/pi-dap test -- <focused-test-file>
```

Then run:

```bash
pnpm format
pnpm verify
pnpm pack:check
git diff --check
```

Finally reload Pi and smoke-test the actual extension in a TUI:

1. launch the configured Node profile with `stopOnEntry`;
2. confirm the widget changes launching → stopped;
3. expand launch, breakpoint, stack, variables, and evaluate rows;
4. continue to a Breakpoint and confirm running state appears before the call returns;
5. confirm a large variables result is bounded in the Observer UI and still produces the existing
   raw Result Spill for the agent;
6. continue to exit, confirm the terminated snapshot, wait 10 seconds, and confirm widget removal;
7. run idempotent `status` and `stop`; and
8. remove the fixture and confirm a clean worktree except for intended changes.

**Complete when:** `pnpm verify` passes, the live smoke test satisfies all eight checks, the package
pack includes all three new source modules, and no agent-facing `dap` content regression exists.

## Acceptance checklist

- [ ] The final model-visible `dap` text and Result Spill behavior are unchanged.
- [ ] All twelve calls and results have compact human renderings with native expansion.
- [ ] Expanded structured sections are capped at 20 rows with omitted counts.
- [ ] Human-visible Debuggee output is terminal-safe; raw agent output remains untouched.
- [ ] Long waits show immediate, one-second partial progress and clean up their timers.
- [ ] Cancellation states distinguish the wait from the still-live Debug Session.
- [ ] The one-line widget updates from observed activity only and sends no DAP request.
- [ ] Running clears stopped-epoch presentation immediately.
- [ ] The widget is absent while idle and disappears 10 seconds after termination.
- [ ] Width, TUI/RPC, fallback, reload, and idempotent-disposal tests pass.
- [ ] Only actionable asynchronous failures notify.
- [ ] The ADR and README distinguish Observer UI from directly operated debugger UI.
- [ ] No footer, command, shortcut, panel, persistence, or new DAP operation was added.
- [ ] `pnpm verify` and the live TUI smoke test pass.
