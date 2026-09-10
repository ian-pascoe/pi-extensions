# @ian-pascoe/pi-dap

Managed and explicitly configured [Debug Adapter Protocol](https://microsoft.github.io/debug-adapter-protocol/)
(DAP) sessions for [Pi](https://github.com/earendil-works/pi).

## Install

```bash
pi install npm:@ian-pascoe/pi-dap
# or
pi install git:github.com/ian-pascoe/pi-extensions
```

For a local checkout, run `pi -e ./packages/pi-dap/src/index.ts`.

## Direct scripts, without configuration

Launch a direct Node JavaScript file (`.js`, `.mjs`, `.cjs`) or Python script (`.py`):

```json
{ "operation": "launch", "program": "app.js" }
```

The built-in Launch Profile IDs are `javascript` and `python`. They stop on entry
and use the internal console. TypeScript loaders, frameworks, test runners, and
build steps require an explicit Launch Profile; Pi DAP does not infer them or
install project dependencies.

Explicit selections and an existing sole configured profile retain ownership.
Otherwise, Pi DAP prefers project-local tools/runtimes, then PATH, then a private
Managed Installation. JavaScript discovery checks ancestor `node_modules/.bin/node`
(or `node.exe`), `node_modules/node/bin/node`, and standalone entrypoints under
`node_modules/@vscode/js-debug/src` or `node_modules/vscode-js-debug/src`; PATH can
provide Node and `dapDebugServer.js`. Python discovery checks ancestor `.venv` and
`venv` interpreters, then `python3`/`python` on PATH, probing those interpreters for
`debugpy.adapter`. Native Windows interpreter paths use `Scripts/python.exe`.
Discovery starts at the script's directory, or the supplied launch `cwd`.

Adapter Python and Debuggee Python are selected separately: private debugpy can
launch your project's interpreter without installing debugpy into its environment.
Executables and script paths are passed as argv, not shell command strings.

Missing adapters and supporting Node/Python runtimes are automatically installed
on the first actual launch. That launch waits with visible tool progress and can
be cancelled; startup and discovery do not download anything. Managed binaries,
metadata, and cross-process coordination live in `<Pi agent directory>/managed-tools`,
shared with Pi LSP and Pi Formatter. Pi settings remain the configuration authority.
The private installer does not modify user PATH, shell configuration, project
manifests, or external tool installations.

First installation selects latest upstream. Existing versions are reused without
registry refresh until an explicit update. For Installed-only Mode, set
`"dap": { "autoInstall": false }`: existing external and managed tools still work,
while missing tools fail without acquiring even the Installer Helper. This is not
a network sandbox; explicit updates remain deliberate network operations.

## Settings

Pi DAP reads only the `dap` key from Pi's global `settings.json` and trusted
project `.pi/settings.json`:

```json
{
  "dap": {
    "autoInstall": true,
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
Untrusted project settings are ignored. Null and invalid same-ID Adapter Definitions
or Launch Profiles also shadow built-ins. Any configured profile map entry suppresses
unselected inference, including quarantined entries; select or repair a profile
rather than silently replacing failed configuration. Explicit commands never fall
back to a managed replacement. `autoInstall` is a boolean, defaults to `true`, and
trusted-project values override global values. Use Pi `/reload` to reload settings.

### Supported Adapters and platforms

Microsoft `vscode-js-debug` for Node JavaScript and `debugpy` for Python are the
Supported Adapters. Explicit profiles can configure TypeScript launchers. Other
standards-based adapters remain Experimental.

Native x64 and ARM64 Linux, macOS, and Windows are equal release targets. The
initial acquisition/launch probes passed on Ubuntu 24.04.5, macOS 15.7.9, Windows
Server 2025 x64, and Windows 11 Enterprise ARM64, using host Node 22.19.0 and
Pi 0.85.1. See the [installer's verified baselines](https://github.com/ian-pascoe/pi-extensions/tree/main/packages/pi-tool-installer#initial-verified-baselines)
for exact tool versions and verification limits. Those versions are evidence,
not release pins. macOS built-in JavaScript launches use a short private IPC
directory to respect Unix socket path limits.

## `/dap update [id]`

```text
/dap update
/dap update javascript
/dap update python
/dap update cancel
```

Updates cover only installed managed DAP presets, never unused presets or
project-local/PATH tools. Results show old/new component versions, no-change
outcomes, and per-tool failures. A failed or cancelled update retains the prior
working installation. Live Debug Sessions stay on their original executables;
the next launch resolves the updated selection.

The interactive loader supports Escape and waits for cancellation cleanup before
closing. RPC clients receive status/notifications and can issue `/dap update cancel`;
RPC's ordinary agent abort does not cancel idle commands. JSON/print have no
interactive cancellation UI; SDK hosts can cancel by shutting down the session.
Reload/shutdown also cancels pending launches and updates idempotently.

## `dap` tool

Pi DAP registers one strict `dap` tool with exactly these operations:

```text
launch            set_breakpoints   continue          next
step_in           step_out          pause             stack
variables         evaluate          status            stop
```

`launch` selects a profile. It may be omitted when exactly one valid configured
profile exists, or when no profile is configured and `program` selects a built-in
direct script profile. `program`, `args`, and `cwd` replace the same profile
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

Pi DAP supports configured stdio and TCP adapters, built-in direct-script profiles,
one active Debug
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
