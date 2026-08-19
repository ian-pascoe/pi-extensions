# Add the `@ian-pascoe/pi-codemode` package

**Status:** Implemented

## Outcome

Add a source-TypeScript Pi extension that runs persistent JavaScript notebook
Cells in QuickJS runtimes isolated by pinned Deno subprocesses and delegates
nested calls to Pi's exact registered tool handlers. Three model-facing tools execute a cell, poll
its result, or cancel its CodeMode Session. Exposure rules decide whether each
registered Pi tool is direct-only, CodeMode-only, or available through both
interfaces.

Read before implementation:

- [`../../AGENTS.md`](../../AGENTS.md)
- [`../../CONTEXT-MAP.md`](../../CONTEXT-MAP.md)
- [`../../packages/pi-codemode/CONTEXT.md`](../../packages/pi-codemode/CONTEXT.md)
- all current package ADRs in [`../../packages/pi-codemode/docs/adr/`](../../packages/pi-codemode/docs/adr/)
- [`../research/2026-08-18_pi-codemode-feasibility.md`](../research/2026-08-18_pi-codemode-feasibility.md), especially the QuickJS update and Pi registry analysis
- [`../adr/0001-package-naming-strategy.md`](../adr/0001-package-naming-strategy.md)
- [`../adr/0002-publish-pi-extensions-as-source-typescript.md`](../adr/0002-publish-pi-extensions-as-source-typescript.md)
- [Pi extension lifecycle and tool documentation](../../.repos/pi/packages/coding-agent/docs/extensions.md)
- [`quickjs-emscripten@0.32.0` lifecycle documentation](../../node_modules/quickjs-emscripten/README.md) after the package dependency is installed

The package context, confirmed contract, and two ADRs are approved inputs. Use
their canonical CodeMode Session, Cell, Notebook Binding, and Exposure Mode
terms in identifiers, tests, errors, and user documentation.

## Boundaries

- Register exactly `codemode_execute`, `codemode_result`, and
  `codemode_cancel`. Keep `src/index.ts` a thin default export.
- Use one subprocess from the exact official `deno@2.9.5` npm dependency per
  live CodeMode Session. Deno executes the shipped source-TypeScript process and
  hosts one QuickJS runtime/context. Use no Codex host, Bun runtime, Node worker
  thread, Node `vm`, subprocess REPL, or upstream Pi change.
- Call Pi's effective wrapped tools through the captured `AgentSession`; add no
  built-in names, constructors, handlers, or fallback implementations.
- Give guest code QuickJS's ECMAScript built-ins and the read-only `tools`
  object, subject to the explicit Cell dialect below. Expose no Node/Bun/Deno
  globals, console, timers, filesystem, network, module loader, or recursive
  CodeMode tools.
- Keep V1 sessions memory-only and scoped to one Pi session generation. Put the
  Notebook Binding store under one owner so a later JSON checkpoint can replace
  its storage mechanics; add no persistence interface, file format, replay, or
  save/restore tool in V1.
- Publish source TypeScript only. Add no build, `dist`, `main`, `types`, or
  `exports` contract.
- Prepare public version `0.1.0`, add no bootstrap Changeset, run no publish
  command, and pause on either tracer's stop condition instead of weakening the
  confirmed contract.

## Runtime contract

### Public tools

Use strict TypeBox objects with camel-case fields and no additional properties:

```ts
codemode_execute({
  script: string,
  timeoutMs?: number,
  wait?: boolean,
  sessionId?: string,
});

codemode_result({ sessionId: string });
codemode_cancel({ sessionId: string });
```

`wait` defaults to `true`; `timeoutMs` has no default and, when present, is a
positive safe integer. An omitted `sessionId` creates an opaque UUID. A supplied
unknown ID fails rather than creating a caller-named session.

All three tools return the same schema-derived union:

```ts
type CodeModeResult =
  | { result: "success"; sessionId: string; data?: JsonValue }
  | { result: "pending"; sessionId: string }
  | {
      result: "failed";
      sessionId: string;
      error: { code: string; message: string };
    };
```

Allocate and retain a failed record when new-session admission fails so every
response still has a stable `sessionId`. Use stable error codes for unknown,
busy, capacity, script, serialization, timeout, cancellation, termination, and
runtime failures. Expected failures are result values; defects use a searchable
`Pi CodeMode:` error prefix.

Accepted `wait: false` executions always return `pending`, even if the Deno
process finishes before the outer call returns. Completion is polling-only.
`codemode_result` repeats the active or latest terminal result without consuming
it. One CodeMode Session accepts one active Cell; another execute fails as busy.
`codemode_cancel` terminates either a pending or idle live session and frees its
Deno subprocess. A successful cancel call returns `success`, while the cancelled
session's retained terminal result becomes `failed` with the cancellation code.
Only live Deno processes count toward `maxSessions`; failed records remain
pollable without consuming capacity. Retain at most 64 process-free
terminal/admission
records per Pi session, evicting the least-recently-accessed record before
admitting another. Never evict a live or pending session.

### Notebook JavaScript

Define and test the Cell dialect with a real ECMAScript parser. Regex rewriting
is outside the contract.

- Top-level `let`, `const`, `var`, function, class, and destructuring bindings
  become Notebook Bindings available to later Cells without `globalThis`.
- A Notebook Binding keeps one stable identity across Cells. Assignment and a
  successful later declaration update that identity, so a function created in
  an earlier Cell observes the latest value. A declaration initializer must
  succeed before replacing the prior value.
- A later declaration may replace a `const` Notebook Binding; ordinary
  assignment to the current `const` still fails. Nested/local declarations keep
  standard JavaScript lexical behavior. Top-level declarations use this explicit
  notebook dialect rather than global-script redeclaration/TDZ rules.
- Top-level `await`, explicit top-level `return`, and automatic final-expression
  results are supported.
- Existing Notebook Binding mutations and completed declaration commits are not
  rolled back when a later statement throws. An ordinary syntax, script, or
  catchable tool failure leaves the session reusable.
- Functions and classes retain normal JavaScript closures. Imports and exports
  are rejected because the guest has no module loader.
- Only statically parsed Program-scope declarations become Notebook Bindings.
  `eval`/`Function`-created declarations, Annex-B block declarations, and
  declarations nested under a `with` statement stay local to their ordinary
  QuickJS scope. Dynamic code may read/write an existing Notebook Binding only
  when normal lexical lookup reaches the binding environment; it cannot create
  a persistent binding implicitly.
- `undefined` as the Cell's complete result means successful completion with no
  `data`; non-JSON values nested in returned data fail serialization.

Use Acorn to parse ECMAScript with top-level await/return enabled, then apply
AST-range edits that place each Cell in an async closure over a process-owned
Notebook Binding environment. Transform Program-scope declarations into
binding-environment definitions after successful initialization, collect
destructured names structurally, and turn the final expression into the Cell
result. Define functions/classes inside the binding environment so their free
top-level names resolve through stable Notebook Binding identities rather than
copied Cell-local values. The environment mediates lookup, assignment,
redefinition, and const protection without becoming a model-facing
`globalThis` convention. Add a code generator only if red syntax or scope tests
prove range edits insufficient.

### Deno process runtime and protocol

Use `quickjs-emscripten@0.32.0`'s synchronous release variant with regular
`newPromise()` deferreds. Do not use Asyncify: it permits only one suspended
action and cannot implement concurrent guest tool calls.

Each Deno subprocess owns one QuickJS runtime/context and:

- a 128 MiB QuickJS heap limit;
- a 1 MiB QuickJS stack limit;
- an interrupt handler for configured deadlines;
- the Notebook Binding environment;
- one active Cell promise;
- all guest deferred handles and pending nested-call IDs.

The parent also installs a deadline watchdog. Timeout, cancellation, Pi
termination, process error, reload, or shutdown aborts in-flight nested tools,
terminates the Deno subprocess, records one fatal result, and makes the session
non-reusable. A registered Pi tool that ignores its `AbortSignal` cannot be
forcibly killed inside Pi's process; quarantine its late settlement so it cannot
touch a closed process/session, and document this unavoidable parity with Pi's
own top-level cancellation.

Define one strict, versioned parent/process protocol with session, Cell, batch,
and nested-call IDs. Parse both directions. Carry guest inputs, Pi tool results,
and Cell results as bounded JSON strings rather than arbitrary structured-clone
objects. Enforce JSON compatibility and an 8 MiB UTF-8 limit before every send:

- finite numbers, booleans, strings, null, dense arrays, and plain data objects
  are accepted;
- cyclic values, bigint, functions, promises, symbols, non-finite numbers,
  sparse arrays, accessors, and oversized content fail explicitly;
- guest `undefined` is accepted only as the complete optional Cell result;
- parent serialization inspects property descriptors so a hostile getter or
  `toJSON` is not invoked accidentally.

Expose `tools` as a read-only dynamic guest object whose exact string keys come
from the Cell's exposure snapshot. `Object.keys(tools)` reflects that snapshot.
The parent rechecks the snapshot, current exposure, and fresh Pi registry entry
for every nested call, so a saved guest function cannot invoke a tool after it
is hidden or removed.

Guest tool calls created during one QuickJS job drain share a batch ID. Buffer
the batch until the Deno process closes that drain. If any current wrapper is
`sequential`, execute the whole batch in arrival order like Pi; otherwise run
the batch in parallel. Calls created by a resumed `.then()`/`await` form a later
batch. Before a Cell settles, pump jobs and drain pending calls to a fixed point;
close the bridge before reporting completion so detached chains cannot outlive
the Cell while holding QuickJS deferred handles. Transport messages as
line-delimited bounded JSON over the subprocess's standard streams.

Use the debug synchronous QuickJS variant in leak tests and its module memory
inspection to prove graceful paths dispose every guest handle, context, and
runtime. Forced Deno termination relies on operating-system process reclamation.

### Pi tool bridge

During `session_start`, capture the owning `AgentSession` with the approved
transient patch:

1. save the exact `AgentSession.prototype.getAllTools` descriptor;
2. install a synchronous wrapper that records `this` and delegates;
3. call this extension's `pi.getAllTools()`;
4. restore the exact descriptor in `finally`;
5. verify the captured shape before registering a CodeMode tool or changing
   direct exposure.

The capability gate verifies the tested public methods, trust-aware
`settingsManager`, installed `agent.beforeToolCall`/`afterToolCall` hooks,
private `_toolRegistry` `Map`, and executable wrapper shapes. Keep the structural
cast in one module with a safety comment. Read `_toolRegistry` fresh for every
call because Pi replaces the map on refresh. A failed gate warns once and leaves
Pi's active tools unchanged.

For each admitted nested call, reproduce Pi 0.84.2's order:

1. resolve the current exact wrapped tool;
2. run `prepareArguments`;
3. call Pi's `validateToolArguments`;
4. call `agent.beforeToolCall` and preserve its post-validation input mutation;
5. honor block/reason/terminate;
6. execute the wrapper with its live ExtensionContext, Cell signal, and bounded
   update callback;
7. normalize thrown execution errors;
8. call `agent.afterToolCall` for executed calls, including thrown calls;
9. apply content/details/isError/usage overrides and preserve the handler's
   termination flag;
10. resolve `{ content, details }` or reject guest `CodeModeToolError`.

Represent each guest batch with a synthetic Assistant Message containing its
nested tool-call blocks in arrival order, and pass Pi's current agent state as
the hook context. Keep this synthetic message out of the transcript; it exists
only to satisfy the same hook contract as Pi's top-level loop. Derive its
api/provider/model/timestamp fields from the outer Assistant Message containing
the CodeMode tool call when available; otherwise use one stable test/manual-call
fallback. Pass the Cell's AbortSignal to both hooks and merge the after-hook
result exactly as `agent-loop.ts` does, including content, details, isError,
usage, and termination.

A terminating block/result aborts sibling nested calls, force-terminates the
CodeMode Session, and propagates outer `terminate`; guest code cannot catch it.
Ordinary blocked/thrown/`isError` results reject catchably. Aggregate nested
usage and `addedToolNames` onto the next outer terminal result. Nested calls run
Pi hooks but append no independent tool-call/result messages to the main
transcript. Forward nested updates only while an awaited outer
`codemode_execute` still accepts updates.

Usage and `addedToolNames` are AgentToolResult metadata on the outer Pi tool,
not fields added to the public `CodeModeResult` stored in `details` or rendered
as `data`.

### Tool exposure and settings

Read `codemode` independently from the captured session's trust-aware global and
project settings documents:

```json
{
  "codemode": {
    "maxSessions": 8,
    "tools": [
      { "pattern": "*", "exposure": "codemode-only" },
      { "pattern": "bash", "exposure": "direct-and-codemode" },
      { "pattern": "browser_*", "exposure": "direct-only" }
    ]
  }
}
```

Rules use case-sensitive minimatch syntax against exact registered names; the
last matching rule wins. A project `tools` array replaces the global array and
a project `maxSessions` overrides the global value. `maxSessions` defaults to
8 and is a positive safe integer. Unknown fields, malformed values, or invalid
patterns disable CodeMode for that Pi session, leave active tools untouched,
and produce one path-qualified warning. `/reload` reconstructs the extension
and rereads settings.

Pi's globally allowed/excluded registry remains authoritative. For present
registry entries:

- an unmatched active tool defaults to `direct-and-codemode`;
- an unmatched inactive tool remains unavailable;
- an explicit rule may activate direct access or expose an inactive wrapper to
  CodeMode;
- CodeMode's own three tools are forced `direct-only`.

`before_agent_start` alone cannot enforce these rules against later dynamic
registration. After the capability gate, install an instance-local wrapper
around the captured session's `setActiveToolsByName`. Preserve and restore its
exact original descriptor. Keep three distinct sets: Pi's pre-policy requested
active names, the last policy-applied direct names, and the last observed
registry names. A call whose registry changed, or whose names equal the last
applied set, is an internal refresh: retain existing requested names, remove
deleted names, and add newly registered names that Pi requested active. Any
other call is an external active-set selection and replaces the pre-policy set.
Classify from that pre-policy set and the fresh registry, then delegate only the
policy-adjusted direct names. Explicit Exposure Modes never rewrite the
pre-policy set.

Because Pi's registry refresh also calls this method, the same seam handles
registrations during load, `session_start`, `before_agent_start`, and tool
execution. Guard synchronization against reentrancy when an updated
`codemode_execute` definition is re-registered. On shutdown/reload, call the
original method with the retained pre-policy names intersected with the current
registry before restoring the exact descriptor. Amend ADR-0002 with this
active-set seam before source implementation. `setActiveToolsByName` is normally
inherited: save any pre-existing own descriptor plus the inherited callable,
install one own wrapper, and delete that property on restore when no own
descriptor originally existed.

Use the same exposure decision for direct names, guest names, and the generated
catalogue. No branch may derive these lists independently.

### TypeScript tool catalogue

Before each provider snapshot—and synchronously after a registry/active-set
refresh when metadata changed—re-register `codemode_execute` with a description
containing deterministic declarations for every CodeMode-exposed tool:

```ts
type PiToolResult = {
  content: Array<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
  >;
  details?: unknown;
};

declare const tools: Readonly<{
  readonly ["read"]: (input: {
    path: string;
    offset?: number;
    limit?: number;
  }) => Promise<PiToolResult>;
}>;
```

Render Pi's structural JSON schemas locally; TypeBox has no reverse declaration
generator. Support local `$defs`/`$ref`, primitive and type-array unions,
`const`, `enum`, `anyOf`/`oneOf`, `allOf`, objects/required properties,
additional properties, arrays, and tuples. Unsupported, external, recursive,
or depth-limited regions become `unknown` rather than misleading TypeScript.
Escape names and JSDoc descriptions, sort deterministically, exclude reserved
tools, cap each JSDoc description at 2 KiB, and cap the complete catalogue at
1 MiB of UTF-8. On overflow, first replace the largest rendered input schemas
with `unknown`, then omit JSDoc while retaining every exact tool name. If names
and `unknown` signatures alone still exceed 1 MiB, reject the candidate exposure
decision before changing direct/guest visibility; retain the last coherent
decision, or disable CodeMode without changing Pi tools when no prior decision
exists. Validate emitted declarations with the repository's TypeScript compiler
in tests. Re-register only when text changes.

## Intended module map

| File                                  | Sole owner                                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------------------- |
| `src/index.ts`                        | Thin extension entrypoint                                                                   |
| `src/pi-codemode-extension.ts`        | Pi composition, lifecycle, synchronization, and warning ownership                           |
| `src/pi-codemode-settings.ts`         | Settings wire schema, layer resolution, defaults, and compiled exposure rules               |
| `src/pi-agent-session-capture.ts`     | Transient receiver capture and private capability gate                                      |
| `src/codemode-tool-exposure.ts`       | Exposure decisions and instance-local active-set seam                                       |
| `src/pi-tool-bridge.ts`               | Exact wrapped-tool preparation, hooks, batching, execution, updates, and result translation |
| `src/codemode-tool-catalog.ts`        | Bounded JSON Schema to TypeScript declarations                                              |
| `src/codemode-tool-contract.ts`       | Public TypeBox inputs, result union, stable errors, and tool definitions                    |
| `src/codemode-runtime.ts`             | Explicit parent clock and CodeMode Session ID capabilities                                  |
| `src/codemode-deno-launch.ts`         | Installed Deno binary, offline import map, and permission resolution                        |
| `src/codemode-deno-process.ts`        | Deno process acquisition, protocol I/O, and deterministic release                           |
| `src/codemode-session-coordinator.ts` | CodeMode Session admission, execute/result/cancel, and fatal transitions                    |
| `src/codemode-worker-protocol.ts`     | Strict versioned parent/process messages and bounded JSON parsing                           |
| `src/codemode-cell-transform.ts`      | AST-defined Cell dialect and Notebook Binding commits                                       |
| `src/codemode-worker.ts`              | Deno process entry, QuickJS context, guest bridge, promise pumping, and handle disposal     |

Use plain classes/functions and private callbacks. Add no one-implementation
service interface, generic manager layer, custom renderer, or bare `config.ts`,
`types.ts`, `utils.ts`, `helpers.ts`, or `handlers.ts` file. Export only symbols
crossing one of the module seams above and give each export a one-line
constraint comment. The map is a ceiling, not a file-count target: keep capture
inside the Pi bridge or another listed owner when extraction would only create a
forwarding module.

## Implementation sequence

### 1. Establish the baseline and prove the shipped Deno process

Record:

```bash
git status --short
git rev-parse HEAD
pnpm verify
pnpm changeset:status
```

The expected starting changes are `CONTEXT-MAP.md`, the CodeMode feasibility
report, `packages/pi-codemode/CONTEXT.md`, ADR-0001, ADR-0002, and this plan.
Stop for review if unrelated source/configuration changes are present.

Create the public package shell with the repository's metadata, scripts, strict
NodeNext `tsconfig`, MIT license, initial changelog/README, and inert thin
entrypoint. Declare:

- runtime dependencies `deno@2.9.5`, `quickjs-emscripten@0.32.0`,
  `minimatch@^10.2.5`, and Acorn;
- wildcard peers for Pi agent-core, Pi AI, Pi coding-agent, and `typebox`;
- Node `>=22.19.0` and `pi.extensions: ["./src/index.ts"]`.

First implement only enough protocol/process code to load QuickJS, evaluate a
constant expression, return bounded line-delimited JSON, and terminate. The
Deno-transitive graph uses explicit `.ts` local import specifiers; Pi's source
loader does not run inside the subprocess. Start the exact platform binary
provided by the official `deno@2.9.5` optional dependency without trusting its
postinstall convenience script. Use `--node-modules-dir=none` so Deno executes
the shipped TypeScript even when installed below `node_modules`, and supply an
in-memory import map built from Node-resolved installed QuickJS ES modules. Add
no download, build, generated fallback, or install-time write. Grant read access
only to QuickJS's release-sync WASM package and deny network, environment,
system information, subprocess, write, FFI, and remote-import capabilities with
permission prompts disabled. Record the decision and installed-layout evidence
in package ADRs.

Wire the tenth inert entrypoint and package count into the root manifest,
entrypoint/override tests, `.pi/settings.json`, pack check, and Git-install check
in this step so those installed-layout proofs can run before broader source
implementation. Review `scripts/root-project-contract.mjs` as the shared schema
authority and either update it or record why its generic schemas remain valid.
Search all root scripts/tests for hard-coded nine-package assertions. Add one
reusable root smoke helper and extend both
package-tarball and clean production Git-install checks to start the actual
shipped `src/codemode-worker.ts`, evaluate the tracer Cell, and stop it. Loading
the extension entrypoint alone is insufficient. Verify the complete Deno graph
in workspace, installed tarball, and Git-copy layouts uses only production
dependencies and packaged WASM assets under parent Node 22.19.0.

**Stop condition:** pause if the pinned Deno source-TypeScript process or
`quickjs-emscripten` assets do not run from all three installed layouts. Do not
add a build pipeline, checked-in generated worker, runtime download, or broader
permission grant as a fallback without a new design decision.

**Complete when:** the inert entrypoint creates no subprocess, while explicit
smoke execution returns the same value and leaves no live Deno process in
workspace, tarball, and production Git-install layouts.

### 2. Prove the notebook dialect in real QuickJS

Implement `codemode-cell-transform.ts` and the Notebook Binding portion of the
Deno process. Keep the AST transform pure and cover:

- `let`/`const`/`var`, function, class, multiple declarations, and nested
  destructuring;
- top-level await, explicit return, final expression, and no-result success;
- reuse and redefinition across at least three Cells;
- same-Cell const/scoping and stable cross-Cell closure identity;
- an earlier function observing both later assignment and successful
  redefinition of one Notebook Binding;
- a failed redefinition initializer preserving the prior binding value;
- the documented `eval`, `Function`, Annex-B block, and nested-`with`
  non-persistence behavior;
- mutation/declaration state before a later thrown error;
- syntax errors, rejected import/export, and ordinary runtime recovery;
- interaction with `globalThis` without requiring it for persistence.

Run these through a real Deno process and QuickJS context, not only transformed-source
snapshots. Keep focused transform snapshots only where they clarify a syntax
regression.

**Stop condition:** pause if the parser/transform cannot preserve the confirmed
semantics without an undocumented dialect restriction. Do not ship regex
rewrites or silently make declarations Cell-local.

**Complete when:** every agreed declaration/result/error behavior is green in
one persistent QuickJS context and a failing Cell can be followed by a
successful Cell using the retained bindings.

### 3. Complete the process protocol and CodeMode Session coordinator

Implement strict protocol parsing, bounded JSON conversion, dynamic `tools`,
regular QuickJS deferred promises, batch boundaries, fixed-point draining, and
graceful/forced cleanup. Then implement the deep
`CodeModeSessionCoordinator` interface used by the outer tools:

```text
execute(input, signal, onUpdate) -> CodeModeResult
result(sessionId)                -> CodeModeResult
cancel(sessionId)                -> CodeModeResult
shutdown(reason)                 -> Promise<void>
```

First leave one green vertical tracer for create → execute → pending/poll →
reuse → shutdown with one recording tool callback. Expand cancellation,
batching, serialization adversaries, and debug leak accounting only after that
public coordinator path works.

Test with a recording parent tool callback and real Deno subprocesses:

- deterministic `wait: false`, repeated result, busy, unknown ID, and capacity;
- ordinary reusable failure versus fatal timeout/cancel/crash;
- synchronous infinite loop terminated by the parent watchdog;
- awaited outer abort and detached background lifetime;
- `Promise.all`, mixed sequential/parallel batches, chained calls, and detached
  calls drained to a fixed point;
- updates while waiting and no updates after outer settlement;
- cyclic/function/promise/bigint/symbol/non-finite/sparse/accessor/oversized
  values in both directions;
- direct-only, removed, unknown, and recursive tool rejection;
- process error/exit races, exactly-once settlement, idempotent cancel/shutdown,
  late uncooperative parent settlement, and no unhandled rejection;
- debug-variant QuickJS handle accounting on every graceful branch.

Use injected IDs only as an internal constructor capability for deterministic
tests; production uses `randomUUID`. Keep timers/listeners owned by their
session record and clear them on every terminal transition.

**Complete when:** one coordinator instance exercises every state transition
through its four-method interface, no Cell settles with live guest deferreds,
and every forced termination frees its Deno subprocess while quarantining parent work it
cannot kill.

### 4. Parse settings and prove Exposure Mode synchronization

Implement strict settings parsing with real temporary global/project
`SettingsManager` documents. Cover absent/default settings, trusted and
untrusted project layers, field override/array replacement, every exposure
literal, last-match precedence, invalid glob/value/unknown-field disablement,
and warning paths.

Implement the pure exposure decision, then the instance-local
`setActiveToolsByName` seam. Amend ADR-0002 before source implementation to name
this second private integration explicitly. Use real `AgentSession` fixtures to
load CodeMode before and after another extension that registers tools during:

- extension load;
- `session_start`;
- `before_agent_start`;
- a direct tool execution.

Also test explicit external `pi.setActiveTools`, same-name overrides, globally
filtered tools, inactive unmatched tools, forced direct-only CodeMode tools,
reentrancy, and exact descriptor restoration on shutdown/reload.

**Stop condition:** pause if direct visibility, guest visibility, and generated
catalogue cannot agree on the same next provider request for every supported
registration ordering.

**Complete when:** one exposure decision determines all three surfaces,
CodeMode-only tools never appear directly, and invalid/capability-failed startup
changes no active tool.

### 5. Bridge Pi's exact wrapped tools

Implement capture/gating and `pi-tool-bridge.ts` against a real AgentSession.
Start with Pi's built-in `read`, then register a custom tool with a distinctive
closure and ExtensionContext so a copied/fallback implementation cannot satisfy
the test.

Cover prepare/validation, argument mutation, block/reason/terminate, thrown and
`isError` results, post-hook content/details/isError/usage overrides, image
normalization, update acceptance, abort, fresh wrapper lookup after same-name
replacement, added-tool refresh, and mixed execution modes. Prove blocked and
invalid calls do not execute, executed failures still reach the result hook,
both hooks receive the Cell signal/current AgentContext/one complete synthetic
batch Assistant Message, after-hook termination merges exactly once, and nested
calls add no transcript messages.

Exercise the bridge from a real QuickJS Cell for at least:

```js
const first = await tools.read({ path: "README.md" });
const [left, right] = await Promise.all([tools["parallel-left"]({}), tools["parallel-right"]({})]);
return { first, left, right };
```

**Complete when:** deleting the registered Pi handler makes the end-to-end proof
fail, hooks observe the same ordering/mutations as Pi's agent loop, and there is
no built-in-name switch or handler in the package.

### 6. Generate the catalogue and register the public tools

Implement the bounded structural JSON Schema renderer and validate its output
with TypeScript. Use focused examples plus property tests for arbitrary tool
names/JSDoc text, deterministic ordering, depth/recursion fallback, and local
refs. Every guest-callable exact name must occur once; direct-only/unavailable
names must not occur.

Implement the public schemas/tool definitions and compose the extension
lifecycle:

- `session_start`: capture → gate → parse → coordinator → install exposure seam
  → register three tools → synchronize;
- registry/active refresh: recompute one exposure decision and re-register only
  changed catalogue metadata under a reentrancy guard;
- `before_agent_start`: final synchronization before Pi snapshots provider
  tools;
- outer tool calls: parse, call the coordinator, render compact JSON text, and
  return schema-valid details/usage/termination;
- `session_shutdown`: stop admission, abort nested work, terminate Deno subprocesses,
  restore Pi's latest pre-policy requested active set, restore the exact
  active-set method descriptor, and clear the session generation.

Use generation tokens so stale background callbacks cannot mutate a reloaded
session. Add a real extension test proving execute → poll → reuse → cancel,
`maxSessions`, timeout, invalid startup, capability failure, dynamic catalogue,
reload, and shutdown. Keep extension import/load inert.

**Complete when:** Pi registers exactly the three agreed tools for a valid
session, every public result validates, the model-visible description contains
current declarations before provider snapshot, and reload leaves no reference
to the prior runner, subprocess, wrapper, or context.

### 7. Finish package and repository integration

Complete `packages/pi-codemode/README.md` as the caller-facing source for:

- npm/Git installation and tested Pi/Node versions;
- all three tool inputs, result union, error codes, defaults, and examples;
- Notebook Binding/redefinition/closure/failure behavior;
- polling, capacity, cancellation, timeout, fatal-session, and reload behavior;
- exact `tools` result/error shape and generated TypeScript declarations;
- settings, minimatch/last-wins semantics, active/inactive defaults, and trusted
  project override rules;
- QuickJS isolation, fixed resource/message limits, and absent host globals;
- the private Pi compatibility gate and fail-closed behavior;
- the cancellation limit for registered handlers that ignore `AbortSignal`;
- V1 memory-only sessions and the deliberately deferred JSON-only persistence
  policy.

The technical root manifest, signed overrides, count tests, install checks, and
lockfile were wired in Step 1 to enable the tracer. Recheck them here, then
finish the root README package table/selectable path/security note/focused check
and `docs/releases.md` policy for eight scoped bootstrap packages and ten
trusted-publishing packages. Keep tracked `.pi/settings.json` free of a CodeMode
policy override.

Retain and format the approved context/ADRs. Add no bootstrap Changeset.

Run:

```bash
pnpm format
pnpm --filter @ian-pascoe/pi-codemode typecheck
pnpm --filter @ian-pascoe/pi-codemode test
pnpm test:load
pnpm pack:check
pnpm git-install:check
pnpm changeset:status
```

**Complete when:** workspace, installed tarball, and clean production Git copy
load ten ordered extensions and execute QuickJS from the shipped Deno process; every
count/list agrees; the README covers every caller-visible limit; and Changeset
status has no bootstrap entry for CodeMode.

### 8. Run the proof gate

Run in order:

```bash
pnpm format
pnpm verify
pnpm changeset:status
git diff --check
git status --short
```

Inspect the final diff and prove:

- exactly three CodeMode tools are registered and never guest-callable;
- every guest tool resolves through Pi's fresh wrapped registry and complete
  prepare/validate/hook/execute/result path;
- direct, guest, and catalogue exposure come from one decision and remain
  coherent after dynamic registration;
- every Deno process, standard stream, timer, listener, QuickJS context/runtime/handle, and
  accepting callback has one lifecycle owner and terminal path;
- late uncooperative Pi tool settlements are quarantined and documented;
- no guest host capability exists outside the registered `tools` object;
- the package contains no Codex host, Bun runtime, unpinned/runtime-downloaded
  Deno, Node `vm`, built-in tool copy, persistence/replay, console/timer shim,
  guest module loader, custom renderer,
  build output, or one-implementation abstraction;
- package files, root metadata, project overrides, releases, lockfile, and tests
  all agree on ten packages;
- no publish command ran.

**Complete when:** `pnpm verify` is green, notebook semantics and actual Pi
handler identity are proven end to end, installed-layout Deno process smoke tests pass
on Node 22.19.x, every checklist item is evidenced in the diff/tests, and the only
working-tree changes are the approved package/docs/plan plus required root
integration.
