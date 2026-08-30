# @ian-pascoe/pi-codemode

Run persistent TypeScript notebook Cells that compose Pi's registered tools.
CodeMode calls the exact handlers Pi registered; it does not contain substitute
implementations of built-in tools.

Tested with Pi `0.84.2` and Node `22.19.0`. The package installs its pinned
`deno@2.9.5` runtime, which itself transpiles and executes Cells. Its official
npm binaries cover macOS, glibc Linux, and Windows on x64 and arm64.

## Install

```bash
pi install npm:@ian-pascoe/pi-codemode
```

From this repository:

```bash
pi install git:github.com/ian-pascoe/pi-extensions
```

## Tools

### `codemode_execute`

```ts
codemode_execute({
  script: string;
  timeoutMs?: number;
  wait?: boolean;
  sessionId?: string;
});
```

`wait` defaults to `true`. `timeoutMs` has no default. Omitting `sessionId`
creates a Session with a generated ID; supplying an unknown ID creates a Session
under that exact ID.

```ts
const result = await tools.read({ path: "README.md" });
return result.content[0];
```

Set `wait: false` to return immediately with `pending`, then poll the returned
ID. An accepted asynchronous execution always returns `pending`, even if its
Cell finishes before the outer call returns.

### `codemode_result`

```ts
codemode_result({ sessionId: string });
```

Returns the active or latest terminal result without consuming it.

### `codemode_cancel`

```ts
codemode_cancel({ sessionId: string });
```

Stops the session process and frees its capacity. The cancel call succeeds;
subsequent polling returns the retained `cancellation` failure.

### `codemode_sessions`

```ts
codemode_sessions({});
```

Lists every live Session, with idle Sessions first in least-recently-used order,
then running Sessions in least-recently-used order. Listing does not refresh
Session recency.

```ts
type CodeModeSessionsResult = {
  result: "success";
  sessions: Array<{
    sessionId: string;
    state: "idle" | "running";
    cellCount: number;
    lastActivityAtMs: number;
  }>;
};
```

The execute, result, and cancel tools return:

```ts
type CodeModeConsoleEntry = {
  method: "log" | "info" | "warn" | "error" | "debug";
  text: string;
};

type CodeModeResult =
  | {
      result: "success";
      sessionId: string;
      data?: JsonValue;
      reclaimedSessionId?: string;
      console?: CodeModeConsoleEntry[];
    }
  | { result: "pending"; sessionId: string }
  | {
      result: "failed";
      sessionId: string;
      error: {
        code:
          | "unknown"
          | "busy"
          | "capacity"
          | "eviction"
          | "script"
          | "serialization"
          | "timeout"
          | "cancellation"
          | "termination"
          | "runtime";
        message: string;
      };
      console?: CodeModeConsoleEntry[];
    };
```

`AgentToolResult.content` remains exactly this JSON and is the only CodeMode
result text returned to the model. Pi retains additional bounded Presentation
Snapshots in tool-result details for Transcript replay and the TUI.

Cells may call `console.log`, `console.info`, `console.warn`, `console.error`,
and `console.debug`. One call creates one ordered entry without a trailing
newline, while embedded newlines remain intact:

```ts
console.log("answer:", 42);
return 42;
```

```json
{
  "result": "success",
  "sessionId": "...",
  "data": 42,
  "console": [{ "method": "log", "text": "answer: 42" }]
}
```

Formatting matches the pinned Deno Console for format tokens, primitives,
spacing, and multiline inspection. Getters, coercion hooks, and custom
inspectors do not run; CodeMode uses safe inspection instead when that differs
from Deno. Console output arrives only with terminal results. Ordinary script,
serialization, and worker-reported runtime failures retain prior calls. A
timeout, cancellation, termination, or process death may omit them because the
parent kills the worker before it can reply.

## Transcript and Observer UI

The CodeMode Transcript gives all five tools semantic collapsed and expanded
rendering. Session rows prioritize Cell lifecycle, a short Session ID, Cell
Ordinal, returned-value shape, Console-call count, nested-tool count, and elapsed
time. Expanded rows show the full Session ID, explicit call arguments,
TypeScript source, bounded Console output before structured returned data or the
error, and bounded nested-tool names, outcomes, and durations. Nested arguments
and raw nested outputs are never copied into the presentation.

Search rows show the query, result range, and next offset without exposing raw
JSON. Expanding a search shows each exact tool name, display group, highlighted
TypeScript declaration, and any declaration-size failure. Search declarations
are bounded only in the Transcript; the model-facing result remains unchanged.

Status always uses a symbol and text together:

```text
◉ running   ○ idle   ✓ completed
× failed    ■ cancelled   ■ reclaimed   ! timed out
```

Awaited Cells publish a presentation update immediately and once per second.
Collapsed calls show one highlighted line inline or the first eight highlighted
lines of a multi-line Cell, truncating long lines to the viewport width. Expanded
calls wrap long lines and show the complete TypeScript source.
Returned-data display uses Pi's 2,000-line/50-KB limit; complete oversized data
is written to a private Result Spill while the model-facing result remains
unchanged. Result Spill files last for the live Pi session. Replayed history
falls back to its retained bounded data when a prior spill is no longer
available.

In TUI mode, the read-only CodeMode Observer UI appears above the editor during
Cell activity. It shows up to eight running, idle, or recently terminal
Sessions, uses the shortest unique Session prefix of at least eight characters,
and adds `… +N more` when bounded. A footer shows `◉ N running · N live` only
while Cells run. The widget disappears ten seconds after every Session becomes
idle or terminal and remounts on later activity. It has no controls and issues
no hidden CodeMode or Pi tool calls.

## Notebook Bindings

Top-level `let`, `const`, `var`, function, class, and destructuring declarations
become Notebook Bindings. Later Cells in the same session use them without
`globalThis`:

```ts
// Cell 1
let count = 1;
function current() {
  return count;
}

// Cell 2
count += 1;
return current(); // 2
```

A later declaration may replace an existing binding, including a `const`.
Ordinary assignment to the current `const` still fails. Existing functions see
later assignments and successful redefinitions. A failed declaration
initializer preserves the previous value; earlier completed mutations and
declarations in the same failing Cell remain committed.

Cells accept TypeScript syntax, which Deno transpiles without type checking.
Type annotations therefore do not validate tool inputs or results. Cells support
top-level `await`, explicit `return`, and automatic return of the final
expression. Static and dynamic imports, `eval`, and dynamic function
constructors are unavailable. Annex-B block functions, nested lexical scopes,
and declarations beneath a source `with` statement remain Cell-local.

Notebook Bindings use protected non-configurable Deno global properties
internally. Normal unqualified and `globalThis` assignment both observe
`const` protection. Protected runtime names are rejected.

One Cell may run at a time in each session. Ordinary script and catchable Pi
tool failures leave the session reusable. Timeout, cancellation, Pi
termination, or process failure destroys that session's heap.

## Registered tools

The `codemode_execute` description contains a token-bounded catalogue of
complete generated TypeScript declarations for currently exposed registered
tools. It marks the catalogue `COMPLETE` or `PARTIAL`; a partial catalogue keeps
the remaining declarations available through:

```ts
const page = await tools.codemode_search({
  query: "intent or exact registered name",
  group: "optional display group",
  limit: 10,
  offset: 0,
});
```

Search returns stable pages with `items`, `total`, `hasMore`, and `nextOffset`.
Each item contains its exact flat `name`, display-only `group`, bounded
`description`, and complete `declaration`. A pathological declaration above the
search response bound instead has an explicit `declarationError`, without
stalling pagination. Call a discovered tool with `tools[item.name](input)`;
every exposed name remains callable even when its declaration is omitted from
the inline catalogue.

`codemode_search` is also a direct Pi tool, so declarations can be discovered
before starting a Cell. Direct search reads the current exposure catalogue;
in-Cell search reads the Cell's frozen exposure snapshot. Both expose only
CodeMode-callable tools and use the same search implementation.

Ordinary guest tool calls resolve to:

```ts
type PiToolResult<Output = unknown> = {
  content: Array<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
  >;
  details?: Output;
};
```

Each declaration derives its input from `parameters` and its `details` type
from the registered definition's optional `outputSchema`. Source-gated fallback
schemas cover Pi's built-in tools and `@howaboua/pi-codex-conversion` 3.0.23;
tool-provided schemas take precedence. Other missing or unsupported output
schemas remain `unknown`.

Ordinary tool failures reject with a catchable `CodeModeToolError`. A Pi result
that requests termination stops the complete CodeMode Session and cannot be
caught by guest code.

## Exposure settings

Configure Exposure Modes under `codemode` in `~/.pi/agent/settings.json` or a
trusted project's `.pi/settings.json`:

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

Patterns are case-sensitive minimatch globs over exact registered names; the
last match wins. Project `tools` replaces the global array, while project
`maxSessions` overrides only that field. `/reload` rereads settings.

An unmatched active tool defaults to `direct-and-codemode`; an inactive tool
remains unavailable even when it matches a rule. Exposure rules redistribute
Pi's active tools but never reactivate tools disabled by Pi or another extension.
The five registered `codemode_*` tools are always direct-only.
Pi's global allowed/excluded registry remains authoritative. Invalid fields or
patterns disable CodeMode for that session without changing Pi's active tools.

`maxSessions` defaults to 8 and counts only live Deno processes. When capacity
is full, a new Session gracefully stops the least-recently-used idle Session
before starting; its Notebook Bindings are discarded, the new success reports
`reclaimedSessionId`, and polling the old ID returns `eviction`. Running Sessions
are never reclaimed, so admission still returns `capacity` when every process is
busy. Executing or polling refreshes recency; listing and Observer rendering do
not. Up to 64 recent worker-free terminal or failed-admission records remain
pollable.

## Isolation and limits

Each live CodeMode Session owns a pinned Deno subprocess. Deno itself executes
unique `Blob` modules with the `application/typescript` media type, keeping
generated helper source out of ordinary source locations. Every operating-system
permission class is denied: filesystem read/write, network, environment, system
information, subprocesses, FFI, and remote imports.

Guest code receives ECMAScript built-ins, a read-only `tools` object, a frozen
five-method Console facade, and only a frozen `Deno.version` identity. Raw
process and standard-stream access, `Worker`, timers, filesystem/network APIs,
and module loading are withheld. Console calls never write to worker streams and
do not include output from registered Pi tool handlers. The parent watchdog
terminates the subprocess for timeout or an infinite loop. Deno/V8 bounds each
Session to a 128 MiB old-space heap and a 1 MiB stack. Protocol inputs, tool
results, returned data, and Console entries share one 8 MiB UTF-8 worker-message
limit. An oversized response becomes the bounded `serialization` failure and
may omit its Console entries.

Registered Pi tools still execute in Pi's parent process with their normal
permissions and lifecycle hooks. Cancellation aborts them through Pi's
`AbortSignal`; a handler that ignores that signal cannot be forcibly killed, so
its late result is discarded after the CodeMode process stops.

CodeMode uses a capability-gated private Pi `AgentSession` seam, tested against
Pi `0.84.2`, to reach wrapped registered handlers and enforce direct exposure.
An incompatible Pi version fails closed and leaves active tools unchanged.

Sessions are memory-only in this release and end on Pi reload, session switch,
fork, resume, or shutdown. A future persistence format may checkpoint complete
JSON-safe Notebook Bindings; V1 neither serializes heaps nor replays Cells.
