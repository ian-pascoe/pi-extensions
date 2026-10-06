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
          "console": "internalConsole",
          "stopOnEntry": true
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

## Tools

Pi DAP registers one tool per operation, all acting on the same single Debug
Session and grouped under the `dap` namespace:

| Tool                  | Arguments                                                      |
| --------------------- | -------------------------------------------------------------- |
| `dap_launch`          | optional `profile`, `program`, `args`, `cwd`                   |
| `dap_set_breakpoints` | `file_path`, `breakpoints`                                     |
| `dap_continue`        | none                                                           |
| `dap_next`            | none                                                           |
| `dap_step_in`         | none                                                           |
| `dap_step_out`        | none                                                           |
| `dap_pause`           | none                                                           |
| `dap_stack`           | optional `thread_id`, `start`, `count`                         |
| `dap_variables`       | `frame_id` or `variables_reference`; optional `start`, `count` |
| `dap_evaluate`        | `expression`; optional `frame_id`                              |
| `dap_status`          | none                                                           |
| `dap_stop`            | none                                                           |

Every tool is declared to the model (`direct` exposure). Use `dap_stop` to end
a runaway Debuggee and `dap_pause` to interrupt one whose execution wait timed
out.

`dap_launch` selects a profile (it may be omitted only when exactly one valid
profile exists). `program`, `args`, and `cwd` replace the same profile
arguments; relative `program` and `cwd` paths resolve from Pi's project working
directory. A Debug Session is single-active: launching while one is active
fails. Desired Breakpoints are complete per-file lists and survive `dap_stop`
and later launches in the same Pi conversation session; `[]` clears a file.
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
`dap_status` until the next launch. A call rejected because of the Debug
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
result: the Debug Session state, all drained Debuggee output, Desired
Breakpoints, and the operation's complete data (`breakpoints`, `stack_frames`
and `total_frames`, `scopes` or `variables`, or `evaluation`). These results are
not truncated to the transcript limits. A state failure resolves to the
current state with an `error` field instead of rejecting.

## Output and lifecycle

Each successful tool call drains currently unread Debuggee output. Adapter
`output` events with the `telemetry` category are dropped; every other category
(including `important` and uncategorized output) is kept. Pi DAP
retains at most 1 MiB of unread output, reporting discarded older bytes. Tool
text follows Pi's 2,000-line/50-KB visible limit; when truncated, the retained
complete result is written to a Result Spill and its path appears in the
result. Adapter stderr retains its newest 1 MiB in the session directory and
process or protocol failures name that path. Failed requests report the
adapter's own error text and name the path only when stderr has content. With
`--no-session`, Pi provides no session directory, so these files use a private directory under the OS temporary
directory instead. Normal session teardown removes it; forced termination may
leave temporary files behind.

Adapters start lazily at `launch`, use the project working directory, and are
owned by one Pi conversation session. `dap_stop`, launch cancellation, adapter
failure, and session shutdown attempt DAP termination and disconnect before
terminating owned Linux process groups. Session shutdown removes session files.
Cancelling an execution wait only ends that wait; the live Debug Session remains
recoverable.

### Observer UI

In TUI mode, calls and results use compact semantic transcript rows. Expanding a
row shows only explicitly supplied arguments and bounded Breakpoint, Stack Frame,
variable, or evaluation details. Long execution waits update once per second.
Malformed or historical rows fall back to their original tool text.

One widget above the editor follows launching, running, stopped, and terminated
activity. It is derived only from lifecycle transitions and successful results
Pi DAP has already received; it sends no additional DAP request and provides no
human debugger controls. Stopped source locations clear on resume. The terminal
snapshot remains for ten seconds, while idle sessions have no widget. RPC, JSON,
and print modes do not mount it.

The model still receives the unchanged raw `DAP <operation>: <JSON>` text,
Debuggee output, truncation, and Result Spill notice. Only the human-visible copy
of Debuggee output is stripped of terminal sequences and unsafe controls; the raw
tool result and Result Spill retain the original bytes.

## V1 boundary

V1 supports configured stdio and TCP adapters on Linux, one active Debug
Session, source breakpoints, core execution control, stack/variables/evaluation,
and headless `runInTerminal`. The Supported `vscode-js-debug` workflow uses one
adapter-owned primary target channel; it is not a second model-facing Debug
Session, and unrelated, second, or nested `startDebugging` requests are rejected.
V1 excludes attach, restart, function/data/instruction breakpoints, hit counts,
logpoints, memory, disassembly, modules, user-requested child Debug Sessions, raw
DAP requests, `launch.json`, WebSocket, persistence, and a directly operated
debugger UI.

Trusted project settings can run arbitrary local executables with Pi's
permissions. Review adapter commands and configuration before trusting a
project.
