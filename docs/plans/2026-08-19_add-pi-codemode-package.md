# Add the `@ian-pascoe/pi-codemode` package

**Status:** Implemented.

## Outcome

Add a source-TypeScript Pi extension that runs persistent TypeScript notebook
Cells directly in isolated, pinned Deno subprocesses and delegates nested calls
to Pi's exact registered tool handlers. Three model-facing tools execute a Cell,
poll its result, or cancel its CodeMode Session. Exposure rules decide whether a
registered Pi tool is direct-only, CodeMode-only, or available through both
interfaces.

Read before implementation:

- [`../../AGENTS.md`](../../AGENTS.md)
- [`../../CONTEXT-MAP.md`](../../CONTEXT-MAP.md)
- [`../../packages/pi-codemode/CONTEXT.md`](../../packages/pi-codemode/CONTEXT.md)
- package ADRs in [`../../packages/pi-codemode/docs/adr/`](../../packages/pi-codemode/docs/adr/)
- [`../research/2026-08-18_pi-codemode-feasibility.md`](../research/2026-08-18_pi-codemode-feasibility.md)
- [`../adr/0001-package-naming-strategy.md`](../adr/0001-package-naming-strategy.md)
- [`../adr/0002-publish-pi-extensions-as-source-typescript.md`](../adr/0002-publish-pi-extensions-as-source-typescript.md)
- [Pi extension lifecycle and tool documentation](../../.repos/pi/packages/coding-agent/docs/extensions.md)

Use the package context's CodeMode Session, Cell, Notebook Binding, and Exposure
Mode terms in identifiers, tests, errors, and caller-facing documentation.

## Boundaries

- Register exactly `codemode_execute`, `codemode_result`, `codemode_cancel`, and
  `codemode_sessions`.
  Keep `src/index.ts` a thin default export.
- Run one subprocess from the exact official `deno@2.9.5` npm dependency per
  live CodeMode Session. Deno itself transpiles and executes TypeScript Cells;
  use no Codex host, QuickJS, Bun runtime, Node worker thread, Node `vm`,
  subprocess REPL, or upstream Pi change.
- Call Pi's effective wrapped tools through the captured `AgentSession`; add no
  built-in names, constructors, handlers, or fallback implementations.
- Give guest code the read-only `tools` object and ordinary ECMAScript values.
  Withhold raw process, standard streams, `console`, `Worker`, timers, and module
  loading. Expose only a frozen `Deno.version` identity, not raw Deno APIs.
- Start Deno with every operating-system permission class denied. This includes
  read, write, network, environment, system information, subprocess, FFI, and
  remote import permissions.
- Keep V1 sessions memory-only and scoped to one Pi session generation. Add no
  persistence interface, file format, replay, or save/restore tool.
- Publish source TypeScript only. Add no build, `dist`, `main`, `types`, or
  `exports` contract.
- Prepare public version `0.1.0`, add no bootstrap Changeset, and run no publish
  command.

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
codemode_sessions({});
```

`wait` defaults to `true`; `timeoutMs` has no default and, when present, is a
positive safe integer. An omitted `sessionId` creates an opaque UUID. A supplied
unknown ID fails rather than creating a caller-named session.

The execute, result, and cancel tools return the same schema-derived union:

```ts
type CodeModeResult =
  | {
      result: "success";
      sessionId: string;
      data?: JsonValue;
      reclaimedSessionId?: string;
    }
  | { result: "pending"; sessionId: string }
  | {
      result: "failed";
      sessionId: string;
      error: { code: string; message: string };
    };
```

`codemode_sessions` returns every live Session ordered idle LRU first, then
running LRU, without refreshing recency. Stable error codes cover unknown,
busy, capacity, eviction, script, serialization, timeout, cancellation,
termination, and runtime failures. Expected failures are
result values. Accepted `wait: false` executions always return `pending`.
`codemode_result` repeats the active or latest terminal result without consuming
it. One CodeMode Session accepts one active Cell; `codemode_cancel` terminates a
pending or idle live session and retains its cancellation failure. Only live
Deno processes count toward `maxSessions`. At capacity, admission gracefully
stops and awaits the least-recently-used idle process; running Sessions are
never reclaimed. The old ID retains an `eviction` failure, and the replacement
success reports `reclaimedSessionId`. Retain at most 64 process-free terminal or
failed-admission records by LRU.

### TypeScript Cells and Notebook Bindings

Cells use TypeScript syntax. Deno transpiles each Cell module without type
checking; type annotations, interfaces, and generics therefore affect neither
runtime validation nor Pi tool schemas.

The package-local `typescript@6.0.3` parser matches Deno's bundled compiler
version. It performs only source-range declaration planning: it identifies
Program-scope declarations, rejects imports/exports and dynamic import, and
rewrites result/declaration boundaries. Deno, not this parser, transpiles and
executes the Cell.

- Top-level `let`, `const`, `var`, function, class, and destructuring
  declarations become Notebook Bindings available to later Cells without a
  caller-visible `globalThis` convention.
- A Notebook Binding has stable identity across Cells. Earlier closures observe
  later assignment and successful redeclaration. A declaration initializer must
  succeed before it replaces a prior binding.
- A later declaration may replace a `const` Notebook Binding, while ordinary
  assignment to the current `const` fails. Nested/local declarations retain
  ordinary lexical behavior. Bindings use protected non-configurable Deno
  global properties internally; protected runtime names are rejected.
- Top-level `await`, explicit top-level `return`, and automatic final-expression
  results are supported. `undefined` as the complete result is success with no
  `data`.
- Earlier completed mutations and declarations remain committed when a later
  statement throws. Ordinary script and catchable Pi tool failures leave the
  Session reusable.
- Only statically parsed Program-scope declarations become Notebook Bindings.
  Dynamic evaluation and function constructors are unavailable. Annex-B block
  declarations and declarations beneath source `with` remain Cell-local.

The worker imports each transformed Cell as a unique `Blob` with
`application/typescript` media type. This keeps generated helper source out of
normal source locations while allowing Deno to perform the supported TypeScript
transpilation and module evaluation.

### Deno process and protocol

Each live Session owns one Deno process with one active Cell, its Notebook
Bindings, pending nested-call IDs, and a strict, versioned line-delimited JSON
protocol. Protocol inputs, Pi tool results, and Cell results are JSON-only and
bounded to 8 MiB of UTF-8.

Guest calls created in one native microtask drain share a batch ID. The worker
flushes batches, receives settled Pi outcomes, and drains detached/chained calls
to a fixed point before completing the Cell. The parent rechecks the exposure
snapshot and fresh Pi registry for every nested call, so saved guest functions
cannot invoke hidden, removed, or recursive CodeMode tools.

The parent owns the timeout watchdog. A timeout, cancellation, Pi termination,
process error, reload, or shutdown aborts nested work, terminates the Deno
process, records one fatal result, and makes the Session non-reusable. This is
also how synchronous infinite loops stop. A registered Pi handler that ignores
its `AbortSignal` remains in Pi's process; its late updates and settlement are
quarantined.

Deno/V8 bounds each Session to a 128 MiB old-space heap and a 1 MiB stack via
launch flags. Operating-system process termination remains the hard boundary
for fatal execution.

### Pi bridge, exposure, and catalogue

Capture the owning `AgentSession` transiently during `session_start`; capability
failure warns once and changes neither Pi's active tools nor registration. Every
nested call uses Pi's current effective wrapped tool and the normal
prepare/validate/before-hook/execute/after-hook path. A terminating nested
result aborts siblings, terminates the Session, and propagates outer
termination. Aggregate usage and `addedToolNames` only onto the next terminal
outer result.

Read the trusted global/project `codemode` settings independently. Rules are
case-sensitive minimatch globs, last match wins, project `tools` replaces the
global array, project `maxSessions` overrides only that field, and malformed
configuration disables CodeMode without changing Pi's active tools. One
Exposure Mode decision controls direct visibility, guest visibility, and the
generated catalogue. CodeMode's four own tools are always direct-only.

Before each provider snapshot and after relevant registry/active-set changes,
re-register `codemode_execute` only when its bounded deterministic TypeScript
tool catalogue changes. Render structural JSON Schema locally; preserve every
exact callable name, cap JSDoc at 2 KiB and the complete catalogue at 1 MiB,
and degrade complex schemas to `unknown` rather than misleading declarations.

## Intended module ownership

| File                                  | Sole owner                                         |
| ------------------------------------- | -------------------------------------------------- |
| `src/index.ts`                        | Thin extension entrypoint                          |
| `src/pi-codemode-extension.ts`        | Pi lifecycle and composition                       |
| `src/pi-codemode-settings.ts`         | Settings parsing and exposure rules                |
| `src/pi-agent-session-capture.ts`     | Transient receiver capture and capability gate     |
| `src/codemode-tool-exposure.ts`       | Exposure decision and active-set seam              |
| `src/pi-tool-bridge.ts`               | Exact wrapped Pi tool execution                    |
| `src/codemode-tool-catalog.ts`        | Bounded JSON Schema declarations                   |
| `src/codemode-tool-contract.ts`       | Public schemas and result contract                 |
| `src/codemode-runtime.ts`             | Parent clock and Session-ID capabilities           |
| `src/codemode-deno-launch.ts`         | Installed Deno binary and denied permission launch |
| `src/codemode-deno-process.ts`        | Deno protocol I/O and process lifetime             |
| `src/codemode-session-coordinator.ts` | Session admission and transitions                  |
| `src/codemode-worker-protocol.ts`     | Bounded protocol parsing                           |
| `src/codemode-cell-transform.ts`      | TypeScript declaration planning                    |
| `src/codemode-worker.ts`              | Native Deno Cell execution and guest bridge        |

## Implementation and proof sequence

1. **Launch proof.** Declare exact `deno@2.9.5` and `typescript@6.0.3` runtime
   dependencies. Launch the installed Deno platform binary with every OS
   permission class denied, no QuickJS import map or filesystem grant, and no
   runtime download/build/generated fallback. Prove workspace, tarball, and
   production Git-copy workers execute a normal `execute` request containing
   TypeScript syntax that JavaScript-only engines reject, then exit cleanly.
2. **Cell proof.** Test the pure TypeScript declaration planner and real Deno
   Cells for every Notebook Binding form, redefinition, closure liveness,
   failed initializer, top-level `await`/`return`/final expression, local dynamic
   declarations, rejected imports, 8 MiB serialization, and native TypeScript
   syntax. The real-process test—not a Node `Function` test—proves Deno executes
   Cells.
3. **Coordinator proof.** Test the public `execute`, `result`, `cancel`, and
   `shutdown` seam for pending/poll/reuse, batching, fixed-point detached chains,
   exposure refresh, failures, timeout, cancellation, capacity/LRU, and late
   parent settlement/update quarantine. Include a synchronous infinite loop to
   prove parent watchdog termination.
4. **Pi proof.** Use real `AgentSession` fixtures to prove handler identity,
   hooks, direct/guest/catalogue coherence after dynamic registration, settings
   precedence, metadata propagation, and inert load/shutdown cleanup.
5. **Package proof.** Run formatting, package typecheck/tests, root load tests,
   tarball and Git-install checks under Node 22.19.x, and the repository verify
   gate. Confirm no production dependency, launch argument, package asset, or
   current-contract document refers to QuickJS.

## Completion criteria

Complete only when:

- all four tools and their public results preserve the stated contract;
- Deno itself, in the permission-denied subprocess, executes a TypeScript Cell
  from workspace, packed tarball, and clean Git installation;
- Notebook Binding and exact Pi handler behavior are proven end to end;
- timeout/cancellation terminate the process and quarantine late parent work;
- 8 MiB JSON bounds and Deno guest capability withholding are tested;
- no build output, runtime download, Node `vm`, Codex host, Bun runtime,
  QuickJS runtime, custom built-in tool implementation, or persistence/replay is
  introduced; and
- `pnpm verify`, formatting, and install/layout checks are green.
