# Support Cell Console Output in Pi CodeMode

**Status:** Implemented

## Outcome

Let a Cell call `console.log`, `console.info`, `console.warn`, `console.error`,
and `console.debug` without losing its returned data or corrupting the worker
protocol. Capture each call as one ordered Cell Console Output entry:

```ts
type CodeModeConsoleEntry = {
  method: "log" | "info" | "warn" | "error" | "debug";
  text: string;
};
```

Successful and failed terminal results gain an optional `console` array. The
property is absent when the Cell emitted nothing:

```json
{
  "result": "success",
  "sessionId": "...",
  "data": 42,
  "console": [{ "method": "log", "text": "answer: 42" }]
}
```

Read before implementation:

- [`../../AGENTS.md`](../../AGENTS.md)
- [`../agents/domain.md`](../agents/domain.md)
- [`../../CONTEXT-MAP.md`](../../CONTEXT-MAP.md)
- [`../../packages/pi-codemode/CONTEXT.md`](../../packages/pi-codemode/CONTEXT.md)
- [`../../packages/pi-codemode/docs/adr/0001-isolate-codemode-sessions-in-subprocesses.md`](../../packages/pi-codemode/docs/adr/0001-isolate-codemode-sessions-in-subprocesses.md)
- [`../../packages/pi-codemode/docs/adr/0004-separate-transcript-and-observer-presentation.md`](../../packages/pi-codemode/docs/adr/0004-separate-transcript-and-observer-presentation.md)
- [`2026-08-19_add-pi-codemode-package.md`](2026-08-19_add-pi-codemode-package.md)
- [`2026-08-19_improve-pi-codemode-ui.md`](2026-08-19_improve-pi-codemode-ui.md)
- [`../releases.md`](../releases.md)

The design session already added **Cell Console Output** to `CONTEXT.md` and
amended ADR-0001. Keep those edits with this change.

## Decisions

- The pinned Deno 2.9.5 Console is the formatting reference. Preserve its
  format-token behavior, primitive rendering, argument spacing, and multiline
  inspection for the five supported methods.
- Guest getters, coercion hooks, and custom inspectors remain disabled. This is
  the deliberate exception to Deno compatibility. Use captured runtime
  primordials and `Deno.inspect` with colors, getters, and custom inspection
  disabled.
- The facade is frozen, remains a reserved Notebook Binding name, works when a
  method is extracted, and returns `undefined` from every call.
- `dir`, `table`, assertions, traces, groups, counters, timers, profiles, and
  Deno-specific Console extensions stay unavailable. A later feature can add
  them when an agent failure demonstrates the need.
- One Console call creates one `{ method, text }` entry. Preserve call order and
  embedded newlines. Store no synthetic trailing newline.
- Console method names carry presentation meaning only. `warn` and `error` do
  not change Cell success, failure codes, Session reuse, or agent termination.
- Return accumulated entries on normal success and on worker-reported script,
  serialization, or runtime failure. Polling repeats the retained terminal
  result. A later Cell starts with an empty capture.
- Parent-enforced timeout, cancellation, termination, or process death may not
  return prior Console calls because those paths kill the worker before it can
  send a terminal response.
- Keep the current protocol-only stdout and process-failure-only stderr paths.
  The facade writes to neither stream. It captures only guest Cell calls, not
  output produced inside registered Pi tool handlers.
- Deliver Console entries only in terminal results. Pending updates and the
  CodeMode Observer UI stay unchanged.
- The existing 8 MiB worker-message limit covers returned data and Console
  entries together. The existing bounded serialization failure replaces an
  oversized response and may omit its Console entries.
- The expanded CodeMode Transcript shows bounded, sanitized Console text before
  returned data or the error. The collapsed row shows only the Console-call
  count. Transcript truncation does not change model-facing result JSON and
  does not create a new Result Spill format.
- Keep the first sentence of the `codemode_execute` description explicit that
  Cells run in Deno. Add one short sentence naming the five captured methods so
  the agent does not assume Node or a full Console implementation.
- This adds an optional public result field and user-visible behavior. Add one
  minor Changeset for `@ian-pascoe/pi-codemode`; do not edit the package version
  or changelog directly.

## Intended file changes

| File                                  | Change                                                                      |
| ------------------------------------- | --------------------------------------------------------------------------- |
| `src/codemode-console-output.ts`      | Dependency-free method names and shared Console entry types                 |
| `src/codemode-worker.ts`              | Safe Deno-compatible formatting, frozen guest facade, and per-Cell capture  |
| `src/codemode-worker-protocol.ts`     | Strict optional Console entries on `cell-result` and `cell-error`           |
| `src/codemode-session-coordinator.ts` | Carry worker Console entries into retained public results                   |
| `src/codemode-tool-contract.ts`       | Public schemas, types, helpers, and exact model-facing JSON                 |
| `src/codemode-tool-rendering.ts`      | Collapsed count and expanded Console section                                |
| `src/pi-codemode-extension.ts`        | Agent guidance for the supported Deno Console methods                       |
| focused existing test files           | Protocol, contract, real-Deno behavior, rendering, and description checks   |
| `README.md`                           | Result schema, examples, supported methods, delivery, limits, and isolation |
| `CONTEXT.md` and ADR-0001             | Retain the design-session edits and verify final wording                    |
| `.changeset/*.md`                     | One minor release note                                                      |

`codemode-cell-transform.ts`, `codemode-deno-process.ts`, the registered-tool
bridge, Result Spill storage, and the Observer UI need no behavior change. Add
no logging dependency, stream multiplexer, setting, event bus, or Console class
hierarchy.

## Implementation sequence

### 1. Record the baseline and add contract tests

Record `git status --short`, the current commit, package test count, and a green
package typecheck/test run. The starting tree intentionally contains the
approved `CONTEXT.md`, ADR-0001, and this plan.

Add red tests in `codemode-tool-contract.test.ts` for:

- strict success and failed results with ordered Console entries;
- omission on empty success, failure, pending, cancel, and Session-list results;
- rejection of unknown methods, missing text, extra entry fields, and Console
  entries on the pending branch;
- exact `AgentToolResult.content` JSON with `data` before `console`; and
- unchanged JSON for results without Console output.

Create the dependency-free `codemode-console-output.ts` owner for the five
method literals and shared entry shape. Build the strict TypeBox schema in
`codemode-tool-contract.ts` from that method list without pulling TypeBox into
the Deno worker graph. Extend only the success and failed public/detail schemas.
Allow the existing success/failure constructors to accept optional Console
entries while leaving all current call sites source-compatible.

**Complete when:** every public branch validates exactly as listed, existing
no-Console JSON remains byte-identical, and the new Console result test is red
only until the contract implementation lands.

### 2. Extend the strict worker protocol

Add an optional non-empty `console` array to `cell-result` and `cell-error`.
Validate every entry with exact keys, one of the five methods, and string text.
Keep all other protocol variants and version 1 unchanged. The worker and parent
ship together, so no protocol compatibility adapter is needed.

Extend `codemode-worker-protocol.test.ts` to cover:

- result and error round trips with multiple methods and multiline text;
- omission when the array is empty;
- rejection of empty arrays, unknown methods, non-string text, duplicate or
  extra fields, and Console fields on unrelated message variants; and
- the existing oversized-response replacement, proving the bounded
  serialization failure contains no oversized Console payload.

**Complete when:** protocol parsing remains exact and bounded, every old
message fixture still passes, and malformed Console payloads fail at the
process boundary.

### 3. Build the worker facade against pinned Deno

First record direct Deno 2.9.5 output fixtures for the supported methods. Cover
plain strings, empty arguments, multiple arguments, Deno format tokens,
escaped percent signs, primitives, arrays, plain objects, `undefined`, bigint,
symbols, functions, errors, circular values, and multiline inspection. The
fixtures are the compatibility oracle; do not call native Console output from
the worker because stdout is the JSON protocol.

In `codemode-worker.ts`:

1. Capture `Deno.inspect` and every formatter primordial before guest code can
   mutate globals.
2. Format the five methods like the recorded Deno fixtures. Disable colors,
   getters, coercion hooks, and custom inspectors. Preserve native behavior for
   format tokens where safety permits; use safe inspection instead of invoking
   a guest hook where the two requirements conflict.
3. Add one Console-entry array to `ActiveWorkerCell`.
4. Install one frozen, non-writable global facade whose methods append to the
   active Cell and return `undefined`. Keep `console` in the reserved Notebook
   Binding names and remove only its `undefined` masking.
5. Attach the array to `cell-result` or `cell-error` only when non-empty. Clear
   it with the active Cell so later Cells cannot inherit output.

Drive this through real `CodeModeSessionCoordinator` Cells in
`codemode-session-coordinator.test.ts`. Assert:

- all five methods, extracted calls, formatting, ordering, multiline text, and
  separate returned `data`;
- `typeof console === "object"`, `Object.isFrozen(console)`, the five supported
  function properties, missing unsupported methods, and reserved-name
  rejection;
- `warn` and `error` still produce successful Cells;
- an ordinary thrown error and a Cell-result serialization failure retain prior
  Console entries and leave the Session reusable;
- getters, `toString`/`valueOf`, Deno custom inspectors, hostile proxies, and
  guest-mutated built-ins do not execute during formatting;
- `wait: false` polling retains the same terminal entries, while the next Cell
  starts empty; and
- an oversized combined response becomes the existing bounded serialization
  failure without corrupting stdout or killing a reusable Session.

Update the existing capability test that expects `typeof console` to be
`"undefined"`; every other denied capability must remain unchanged.

**Complete when:** real permission-denied Deno Cells match the recorded safe
formatting contract, Console calls never appear as raw process output, hostile
inspection hooks remain untouched, and all existing isolation tests still pass.

### 4. Retain Console entries through the coordinator

In both worker terminal branches, pass validated entries to the public success
or failure constructor. Preserve returned `data`, error code/message,
`reclaimedSessionId`, metadata, Session reuse/fatalization, polling, and
Presentation Snapshot behavior. Parent-created failures without a worker
terminal response remain unchanged and omit `console`.

Keep `structuredCodeModeResult` as the only model-content serializer. Its
existing `JSON.stringify(operation.result)` should expose the optional field
without a second output path.

**Complete when:** execute and poll return byte-identical Console arrays,
ordinary worker errors retain prior output, parent-only failures stay unchanged,
and no Console data enters progress updates or Observer snapshots.

### 5. Render Console output in the Transcript

Update renderer tests before the renderer:

- collapsed success and failure rows include `1 console call` or `N console
calls` only when entries exist;
- expanded results show a `Console` section before `Result` or `Error`, with
  method labels, preserved order, and multiline text;
- `warn`/`error` labels do not replace the Cell lifecycle symbol or color;
- terminal escape/control sequences are removed from presentation while the
  model-facing JSON remains unchanged;
- the Console section uses the existing 50 KiB/2,000-line Transcript bound as
  one aggregate and states omitted lines; and
- historical results without `console` and malformed details keep their
  current rendering/fallback behavior.

Derive the collapsed count directly from `details.console.length`; do not add a
Presentation Snapshot field or Observer state. Keep Result Spill behavior
limited to returned data.

**Complete when:** every terminal result presents Console output once, before
data/error, within existing display limits, and Observer UI tests remain
unchanged.

### 6. Update agent guidance, user docs, and release metadata

Retain the existing Deno-first `codemode_execute` description and append one
sentence naming the five captured methods and terminal delivery. Add an exact
description assertion in `pi-codemode-extension.test.ts` so catalogue refreshes
cannot drop that guidance.

Update `README.md`:

- add `CodeModeConsoleEntry` and optional `console` fields to success and failed
  result examples;
- show one Cell returning both Console output and data;
- document Deno formatting plus the hostile-inspection exception;
- state terminal-only delivery, ordinary-failure retention, fatal-process
  omissions, and the shared 8 MiB limit; and
- replace the claim that `console` is withheld while keeping raw process and
  standard streams denied.

Review the already-edited `CONTEXT.md` and ADR-0001 against the implemented
names. Add one minor Changeset describing captured Deno Console output in Cell
results. Leave `CHANGELOG.md` and `package.json` versions to the Changesets
version workflow.

**Complete when:** the tool description tells the agent it runs Deno and names
the supported methods, README examples match the strict schemas, domain docs
match the code, and `pnpm changeset:status` reports one minor CodeMode change.

### 7. Verify the package and installed worker

Run:

```bash
pnpm --filter @ian-pascoe/pi-codemode typecheck
pnpm --filter @ian-pascoe/pi-codemode test
pnpm test:load
pnpm pack:check
pnpm git-install:check
pnpm verify
pnpm changeset:status
```

Inspect the final diff for accidental changes to Cell transformation, raw
stdio handling, registered-tool execution, Observer UI, package versions, or
unrelated packages.

**Complete when:** every command passes; workspace, packed, and Git-installed
workers execute Console Cells; protocol stdout remains JSON-only; the only new
release metadata is one minor CodeMode Changeset; and the final diff implements
every decision in this plan without an unrequested abstraction.
