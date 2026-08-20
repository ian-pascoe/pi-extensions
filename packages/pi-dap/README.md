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

## `dap` tool

Pi DAP registers one strict `dap` tool with exactly these operations:

```text
launch            set_breakpoints   continue          next
step_in           step_out          pause             stack
variables         evaluate          status            stop
```

`launch` selects a profile (it may be omitted only when exactly one valid
profile exists). `program`, `args`, and `cwd` replace the same profile
arguments; relative `program` and `cwd` paths resolve from Pi's project working
directory. A Debug Session is single-active: launching while one is active
fails. Desired Breakpoints are complete per-file lists and survive `stop` and
later launches in the same Pi conversation session; `[]` clears a file.
Relative breakpoint paths also resolve from Pi's project working directory.

Execution and inspection require a stopped Debuggee: `continue`, `next`,
`step_in`, `step_out`, `stack`, `variables`, and `evaluate`. `pause` requires a
running Debuggee. `status` and `stop` are idempotent. `stack` defaults to the
stopped thread, offset `0`, and count `20`; `variables` takes exactly one
`frame_id` or `variables_reference` and defaults its count to `100`; `evaluate`
defaults to the top Stack Frame.

Execution waits end on a stop, exit, cancellation, or `executionMs`; an
execution timeout reports `running`. Request, startup, and shutdown timeouts
are errors. A natural exit leaves a terminal snapshot available from `status`
until the next launch.

## Output and lifecycle

Each successful operation drains currently unread Debuggee output. Pi DAP
retains at most 1 MiB of unread output, reporting discarded older bytes. Tool
text follows Pi's 2,000-line/50-KB visible limit; when truncated, the retained
complete result is written to a Result Spill and its path appears in the
result. Adapter stderr retains its newest 1 MiB in the session directory and
process or protocol failures name that path.

Adapters start lazily at `launch`, use the project working directory, and are
owned by one Pi conversation session. `stop`, launch cancellation, adapter
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
