# @ian-pascoe/pi-dap

Configured [Debug Adapter Protocol](https://microsoft.github.io/debug-adapter-protocol/)
(DAP) sessions for [Pi](https://github.com/earendil-works/pi).

## Install

```bash
pi install npm:@ian-pascoe/pi-dap
# or
pi install git:github.com/ian-pascoe/pi-extensions
```

For a local checkout, run `pi -e ./packages/pi-dap/src/index.ts`.

Debug Adapter executables are user-managed. Pi DAP has no adapter discovery,
installer, or catalog. The repository-only `vscode-js-debug` development
dependency supports this repository's Node smoke test; its files are not packed
or installed with the package.

## Settings

Pi DAP reads only the `dap` key from Pi's global `settings.json` and trusted
project `.pi/settings.json`:

```json
{
  "dap": {
    "timeouts": {
      "startupMs": 10000,
      "requestMs": 10000,
      "executionMs": 30000,
      "shutdownMs": 5000
    },
    "adapters": {
      "node": {
        "command": "node",
        "args": ["/absolute/path/to/dapDebugServer.js", "$PORT", "127.0.0.1"],
        "environment": {},
        "transport": {
          "type": "tcp",
          "host": "127.0.0.1",
          "port": 0
        }
      }
    },
    "profiles": {
      "node": {
        "adapter": "node",
        "arguments": {
          "type": "pwa-node",
          "console": "internalConsole"
        }
      }
    }
  }
}
```

An Adapter Definition needs a non-empty `command` and `transport`; `args` and
`environment` default to an empty array and object, respectively. `transport` is either `"stdio"` or a
TCP object with `type: "tcp"`; its host defaults to `127.0.0.1`, and a missing
or zero port selects a local port. TCP arguments may use `$PORT` anywhere in an
argument, and Pi DAP also supplies that selected port as `PORT` in the adapter
environment. `$PORT` is invalid for stdio adapters. Environment strings overlay
the inherited environment; `null` removes an inherited variable.

A Launch Profile needs an existing Adapter Definition ID and opaque JSON-object
`arguments`. Global and trusted-project timeouts merge by field. Adapter and
profile maps merge by ID: a project entry replaces the complete global entry;
`null` removes it. Invalid project replacements still shadow global entries.
Invalid entries are quarantined independently and produce path-qualified
warnings at session start, while unrelated valid entries stay available.
Untrusted project settings are ignored. Use Pi `/reload` to reload settings.

### Node and TypeScript

Node/TypeScript through Microsoft `vscode-js-debug` is the Supported Adapter
workflow. For example, set the Node adapter command to `node` and point its TCP
arguments at `dapDebugServer.js` followed by `$PORT`, as above. Other
standards-based adapters are Experimental: they may work through DAP but have
no compatibility promise.

#### `stopOnEntry` re-stops inside the first function

Leave `stopOnEntry` out of a `vscode-js-debug` profile unless you need the
entry stop. For that stop js-debug sets a breakpoint at line 0, column 0 of the
program and never removes it. When the program starts with a function
declaration, V8 moves that breakpoint to the function's first statement, so
every call to the function stops again with reason `entry`, which looks like a
stale stop reason or an ignored breakpoint condition. Without `stopOnEntry`,
`dap_launch` runs to your first breakpoint and each stop is reason
`breakpoint`. To tell the two apart when it does happen, read the stop text:
your breakpoint lists `hit breakpoint ids` (`hit_breakpoint_ids` in
`structuredContent`), while an entry stop has none. The stop `description` is the same
(`Paused on breakpoint`) for both, so rely on the reason and the ids.

## Tools

Pi DAP registers one tool per operation, all acting on the same single Debug
Session and grouped under the `dap` namespace:

| Tool                  | Arguments                                                        |
| --------------------- | ---------------------------------------------------------------- |
| `dap_launch`          | optional `profile`, `program`, `args`, `cwd`, `launch_arguments` |
| `dap_set_breakpoints` | `file_path`, `breakpoints`                                       |
| `dap_continue`        | none                                                             |
| `dap_next`            | none                                                             |
| `dap_step_in`         | none                                                             |
| `dap_step_out`        | none                                                             |
| `dap_pause`           | none                                                             |
| `dap_stack`           | optional `thread_id`, `start`, `count`                           |
| `dap_variables`       | `frame_id` or `variables_reference`; optional `start`, `count`   |
| `dap_evaluate`        | `expression`; optional `frame_id`                                |
| `dap_status`          | none                                                             |
| `dap_stop`            | none                                                             |

Every tool is declared to the model (`direct` exposure). Use `dap_stop` to end
a runaway Debuggee and `dap_pause` to interrupt one whose execution wait timed
out.

`dap_launch` selects a profile (it may be omitted only when exactly one valid
profile exists). `program`, `args`, and `cwd` replace the same profile
arguments; relative `program` and `cwd` paths resolve from Pi's project working
directory. `launch_arguments` is an object of adapter launch arguments for this
launch only, merged (shallow) over the profile's `arguments`, so one launch can
set `autoAttachChildProcesses: false` without editing settings; `program`,
`args`, and `cwd` still win over it. It is named `launch_arguments`, after the
profile's `arguments`, because `args` already means the Debuggee's command-line
arguments. A Debug Session is single-active: launching while one is active
fails. Desired Breakpoints are complete per-file lists and survive `dap_stop`
and later launches in the same Pi conversation session; `[]` clears a file and
drops it from `desired_breakpoints`.
Relative breakpoint paths also resolve from Pi's project working directory.
A breakpoint file that does not exist yet is still stored, with a `warnings` entry
that the breakpoints will not bind until it exists.

Execution and inspection require a stopped Debuggee: `dap_continue`,
`dap_next`, `dap_step_in`, `dap_step_out`, `dap_stack`, `dap_variables`, and
`dap_evaluate`. `dap_pause` requires a running Debuggee. `dap_status` and
`dap_stop` are idempotent. `dap_stack` defaults to the stopped thread, offset
`0`, and count `20`; `dap_variables` takes exactly one `frame_id` or
`variables_reference` and defaults its count to `100`; `dap_evaluate` defaults
to the top Stack Frame. Pi runs a batch of tool calls that includes a DAP tool
sequentially, in the order the model issued them. Calls that a codemode script
starts together, for example with `Promise.all`, are queued the same way by
Pi 1.0.0 and later, so they never overlap on the Debug Session. A script cannot
use one call to interrupt another's execution wait: a `dap_pause` started with
`dap_continue` runs only after the wait ends.

Execution waits end on a stop, exit, cancellation, or `executionMs`; an
execution timeout reports `running`. Request, startup, and shutdown timeouts
are errors. A natural exit leaves a terminal snapshot available from
`dap_status` until the next launch, with `exit_code` when it is known:

- from the adapter's `exited` event;
- with the Supported `vscode-js-debug` adapter, which sends none, from the
  `Process exited with code N` report it makes while it owns the Debuggee's
  output (profile `console` absent or `internalConsole`, and `outputCapture`
  not `std`). Pi DAP infers `0` only there, when the Debug Session ends without
  that report. A Debuggee killed by a signal also reads `0`, because that is
  what `vscode-js-debug` reports;
- with a terminal `console` (`integratedTerminal`, `externalTerminal`), from the
  exit status of the process Pi DAP ran for the adapter. A signal kill has none.

Otherwise `exit_code` is omitted, never guessed: this covers `outputCapture:
"std"`, a Debug Session that `dap_stop` ends, and an adapter failure.
A call rejected because of the Debug
Session state, such as `dap_stack` after the Debuggee exited, is an error
result that still reports the current state.

Versions before 0.4.0 registered one `dap` tool with an `operation` argument.
It has no alias: replace `dap` in `--tools`, `defaultTools`, tool grants such as
Minimal Subagents toolsets, and permission rules with the `dap_*` names (or a
`dap_*` pattern where patterns are accepted). Past `dap` calls in older sessions
remain in the transcript and render with Pi's default tool rendering.

### Annotations and script results

Each tool carries MCP-style annotations that permission extensions can use:

| Tools                                                                                   | Read-only | Destructive | Idempotent | Open world |
| --------------------------------------------------------------------------------------- | --------- | ----------- | ---------- | ---------- |
| `dap_stack`, `dap_variables`, `dap_status`                                              | yes       | no          | yes        | no         |
| `dap_launch`, `dap_continue`, `dap_next`, `dap_step_in`, `dap_step_out`, `dap_evaluate` | no        | yes         | no         | yes        |
| `dap_set_breakpoints`                                                                   | no        | yes         | yes        | yes        |
| `dap_pause`                                                                             | no        | no          | yes        | no         |
| `dap_stop`                                                                              | no        | yes         | yes        | no         |

Launching, resuming, stepping, and evaluating run the Debuggee's code, so they
can do anything the program does. `dap_set_breakpoints` is annotated the same
way because a breakpoint `condition` is also evaluated as Debuggee code.
Replacing a file's breakpoints with the same list changes nothing more, so it is
idempotent.

Each tool declares an output schema. Codemode scripts receive a structured
result: the Debug Session state, all drained Debuggee output, and the
operation's complete data (`breakpoints`, `stack_frames` and `total_frames`,
`scopes` or `variables`, or `evaluation`). `dap_set_breakpoints`, `dap_launch`,
and `dap_status` also carry `desired_breakpoints`; no other tool does. The
execution tools, `dap_pause`, and `dap_status` carry `rejected_child_sessions`
when Pi DAP could not debug a child session (see Child sessions). These
results are not truncated to the transcript limits; the one exception is that `dap_variables`
with `frame_id` leaves expensive scopes unexpanded. A state failure resolves to the
current state with an `error` field instead of rejecting.

## Output and lifecycle

Each successful tool call drains currently unread Debuggee output. Adapter
`output` events with the `telemetry` category are dropped; every other category
(including `important` and uncategorized output) is kept. Pi DAP retains at most
1 MiB of unread output, reporting discarded older bytes.

Tool text is a few compact lines, never a raw JSON dump. A stop reads
`stopped (breakpoint) at app.js:3:5 in add · thread 1`: the top Stack Frame's
file, line, column, and function come with every result that waits for a stop
(and with `dap_status` once one has), so no separate `dap_stack` call is needed.
Further lines carry the adapter's stop `description` and the `hitBreakpointIds`
(matching the `id` values `dap_set_breakpoints` reports for a live Debug
Session). Your breakpoint lists ids and an adapter's entry stop has none, so the
reason and the ids tell them apart. Only `dap_set_breakpoints`, `dap_launch`, and
`dap_status` list Desired Breakpoints in text (the latter two only when some
exist), so a stepping result never repeats them. A call
that waits and ends still `running` says `(wait timed out)`.

Stack Frames, variables, and evaluations are one line per row. In `dap_stack`
text, each run of two or more Stack Frames the adapter hints as noise (a frame
`presentationHint` of `subtle` or `label`, or a source `presentationHint` of
`deemphasize`, as vscode-js-debug sets for runtime internals and async
boundaries) collapses to one line such as `… 13 deemphasized frames (ids 34–46)`.
Those ids still work with `dap_variables` and `dap_evaluate`, a lone hinted
frame keeps its own line, and `stack_frames` in `structuredContent` lists every frame. Adapter strings
are flattened onto one line with `\n` escapes. Drained Debuggee output follows
under its own heading. `structuredContent` keeps its fields' strings verbatim, and adds `stop_description`, `hit_breakpoint_ids`, `top_frame`, and, for a stop in a child session, `child_session`.
`dap_variables` with `frame_id` lists scopes the adapter marks expensive, such
as js-debug's Global, by name and `variables_reference` without expanding them;
pass that reference to expand one. In `structuredContent` such a scope has no
`variables`.

Tool text follows Pi's 2,000-line/50-KB visible limit and is cut at whole lines;
a first line alone over the byte limit is cut mid-line, so the visible part is
never empty. When truncated, the retained complete result is written to a Result
Spill and its path appears in the result. Adapter stderr retains its newest 1 MiB in the session directory and
process or protocol failures name that path. Failed requests report the
adapter's own error text and name the path only when stderr has content. With
`--no-session`, Pi provides no session directory, so these files use a private
directory under the OS temporary directory instead. Normal session teardown removes it; forced termination may
leave temporary files behind.

Adapters start lazily at `launch`, use the project working directory, and are
owned by one Pi conversation session. `dap_stop`, launch cancellation, adapter
failure, and session shutdown attempt DAP termination and disconnect before
terminating owned Linux process groups. Session shutdown removes session files.
Cancelling an execution wait only ends that wait; the live Debug Session remains
recoverable.

### Observer UI

In TUI mode, calls and results follow Pi's built-in tool rendering. The header is
the tool name (`dap_stack`), its target, and muted arguments; expanding a call
lists only explicitly supplied arguments. A result previews the tool text, 20
lines for `dap_stack` and `dap_variables` and 10 for everything else, followed by
Pi's `... (N more lines, ctrl+o to expand)` hint. A running call, including a
long execution wait, shows Pi's `Elapsed` footer and a finished one `Took`.

One `pi-dap` widget above the editor follows launching, running, stopped, and
terminated activity: a `DAP` title with the adapter, profile, and elapsed time,
then a row led by a Status Mark with the state, stop reason or exit code, and
source location. It is derived only from lifecycle transitions and successful results
Pi DAP has already received; it sends no additional DAP request and provides no
human debugger controls. Stopped source locations clear on resume. The terminal
snapshot remains for ten seconds, while idle sessions have no widget. RPC, JSON,
and print modes do not mount it.

The model still receives the compact text, Debuggee output, truncation, and
Result Spill notice described above. Only the human-visible copy
of Debuggee output is stripped of terminal sequences and unsafe controls; the raw
tool result and Result Spill retain the original bytes.

## Child sessions

When the Debuggee starts a worker thread or a child process (a test runner's
workers, for example), `vscode-js-debug` asks Pi DAP to debug it as a child
session with `startDebugging`. Pi DAP opens a channel for the child against the
same adapter process, applies Desired Breakpoints before the child runs, and
starts it, so breakpoints in code a child runs bind like any other. Children of
children are debugged the same way. Launching `vitest run` stops at a breakpoint
in code a test imports, with either the `forks` or the `threads` pool.

Child sessions fold into the one Debug Session (ADR-0003):

- **One stop at a time.** A stop in a child session reads like any other, with
  a `child session:` line (`child_session` in `structuredContent`) naming it:

  ```text
  stopped (breakpoint) at math.js:3:13 in add · thread 1
  child session: forks.js [2992814]
  ```

  `dap_stack`, `dap_variables`, `dap_evaluate`, `dap_continue`, and the step
  tools act on the target whose stop is reported. When several targets stop at
  once (parallel test workers, say), the others wait: the next `dap_continue`
  or step reports a waiting stop at once instead of running on.

- **Thread ids.** Each target numbers its own threads, so with
  `vscode-js-debug` Pi DAP reports its own thread ids, which never collide
  across targets.
- **Breakpoints.** `dap_set_breakpoints` updates every target. A Breakpoint is
  reported verified when any target verified it, under the id the Debuggee's own
  target gave it; `hit_breakpoint_ids` from a child uses those same ids.
- **`dap_pause`** pauses every target and reports the first stop.
- **`debugger;` statements and exceptions** in a child stop like those in the
  Debuggee.
- **Lifetime.** A child that ends closes only its own channel. The Debug
  Session still ends with the Debuggee, and `dap_stop` closes every channel.

A child session Pi DAP cannot debug is named once in the next `dap_launch`,
`dap_continue`, `dap_next`, `dap_step_in`, `dap_step_out`, `dap_pause`, or
`dap_status` result, in text and in `rejected_child_sessions` (`type`, `name`,
`target_id`, `message`); breakpoints in it never bind. To skip debugging child
processes, pass `launch_arguments: { autoAttachChildProcesses: false }`; they
then run without a debugger. Worker threads have no such switch. Paths inside
`launch_arguments` are passed to the adapter as written; only the top-level
`program` and `cwd` are resolved.

## V1 boundary

V1 supports configured stdio and TCP adapters on Linux, one active Debug
Session, source breakpoints, core execution control, stack/variables/evaluation,
and headless `runInTerminal`. The Supported `vscode-js-debug` workflow uses one
adapter-owned primary target channel and one channel per child session, all
folded into the one model-facing Debug Session (see Child sessions).
`startDebugging` requests from other adapters are refused with a failure reply.
V1 excludes attach, restart, function/data/instruction breakpoints, hit counts,
logpoints, memory, disassembly, modules, user-requested child Debug Sessions, raw
DAP requests, `launch.json`, WebSocket, persistence, and a directly operated
debugger UI.

Trusted project settings can run arbitrary local executables with Pi's
permissions. Review adapter commands and configuration before trusting a
project.
