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
creates a new CodeMode Session; supplying an unknown ID fails.

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
    };
```

`AgentToolResult.content` remains exactly this JSON and is the only CodeMode
result text returned to the model. Pi retains additional bounded Presentation
Snapshots in tool-result details for Transcript replay and the TUI.

## Transcript and Observer UI

The CodeMode Transcript gives all four tools semantic collapsed and expanded
rendering. Collapsed rows prioritize Cell lifecycle, a short Session ID, Cell
Ordinal, returned-value shape, nested-tool count, and elapsed time. Expanded
rows show the full Session ID, explicit call arguments, TypeScript source,
structured returned data or error, and bounded nested-tool names, outcomes, and
durations. Nested arguments and raw nested outputs are never copied into the
presentation.

Status always uses a symbol and text together:

```text
◉ running   ○ idle   ✓ completed
× failed    ■ cancelled   ■ reclaimed   ! timed out
```

Awaited Cells publish a presentation update immediately and once per second.
Collapsed calls show one highlighted line inline or the first eight highlighted
lines of a multi-line Cell. Expanded calls show the complete TypeScript source.
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

The `codemode_execute` description contains generated TypeScript declarations
for the currently exposed registered tools. Guest calls resolve to:

```ts
type PiToolResult = {
  content: Array<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
  >;
  details?: unknown;
};
```

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

An unmatched active tool defaults to `direct-and-codemode`; an unmatched
inactive tool remains unavailable. An explicit rule may expose an inactive tool
or activate direct access. The four `codemode_*` tools are always direct-only.
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

Guest code receives ECMAScript built-ins, a read-only `tools` object, and only a
frozen `Deno.version` identity. Raw process and standard-stream access,
`console`, `Worker`, timers, filesystem/network APIs, and module loading are
withheld. The parent watchdog terminates the subprocess for timeout or an
infinite loop. Deno/V8 bounds each Session to a 128 MiB old-space heap and a
1 MiB stack. Protocol inputs, tool results, and Cell results remain JSON-only
and limited to 8 MiB of UTF-8.

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
