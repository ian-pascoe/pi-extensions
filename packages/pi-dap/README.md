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

The direct-script Launch Profiles are `javascript`, `python`, and `deno`.
`deno.json` or `deno.jsonc` selects Deno for JS/TS files even when `package.json`
also exists. An unmarked TypeScript file requires `"profile": "deno"` or an
Explicit Definition. Named `javascript` selection still chooses Node. TypeScript
loaders, frameworks, test runners, and builds are not inferred.

Deno uses a private dependency cache with cached-only resolution, frozen lockfile
validation, manual node_modules mode, and local vendor generation disabled. It
never grants runtime permissions or prompts for them. Prepare dependencies
explicitly; use a complete Explicit Definition for scoped permissions or another
cache policy. A missing dependency is an unavailable launch, not permission to
install project dependencies. Source breakpoints work through js-debug's owned
primary target channel; worker/child sessions are not included.

### Already compiled programs

Select a compiled-program preset explicitly; filenames never trigger a build:

```json
{ "operation": "launch", "profile": "go", "program": "./bin/application" }
{ "operation": "launch", "profile": "codelldb", "program": "./target/debug/application" }
{ "operation": "launch", "profile": "dotnet", "program": "./bin/Debug/net8.0/application.dll", "args": ["example"] }
```

`go` uses Delve's `exec` mode. `codelldb` uses its bundled LLDB/Python closure for
Rust/C++ and expression evaluation rather than treating expressions as debugger
commands. Projects supply compiled binaries and debug symbols.

`dotnet` uses NetCoreDbg and the compiled runtimeconfig, preferring compatible
project/PATH hosts before a private runtime-only installation. The builtin supports
one `Microsoft.NETCore.App` requirement with default/`Minor`, `LatestPatch`, or
`Disable` roll-forward, native AnyCPU/x64/ARM64 assemblies, and self-contained
apphosts with their local bundled runtime. Missing metadata, additional/custom
framework graphs, framework-dependent apphosts, legacy `applyPatches: false`,
additional probing paths, and other roll-forward policies require explicit
configuration. Pi preserves application arguments, leaves the native host in
charge of final compatibility, and does not install a latest SDK, change metadata,
or build the application. Runtime and CLI cache state stay private.

Explicit selections and an existing sole configured profile retain ownership.
Otherwise, Pi DAP prefers project-local tools/runtimes, then PATH, then a private
Managed Installation. JavaScript discovery checks ancestor `node_modules/.bin/node`
(or `node.exe`), `node_modules/node/bin/node`, and standalone entrypoints under
`node_modules/@vscode/js-debug/src` or `node_modules/vscode-js-debug/src`; PATH can
provide Node and `dapDebugServer.js`. Python discovery checks ancestor `.venv` and
`venv` interpreters, then `python3`/`python` on PATH, probing those interpreters for
`debugpy.adapter`. Native Windows interpreter paths use `Scripts/python.exe`.
Discovery starts at the script's directory, or the supplied launch `cwd`.
Deno checks ancestor `node_modules/.bin` before PATH. Known npm/pnpm entrypoints
(POSIX symlinks/shell shims and Windows `deno.cmd`) resolve read-only to an existing
package-local native payload or matching installed optional `@deno` payload.
Incomplete wrappers are skipped so later PATH candidates still precede private
acquisition. Pi does not execute npm's `bin.cjs` repair wrapper or copy/chmod its
payload into the project.

Adapter Python and Debuggee Python are selected separately: private debugpy can
launch your project's interpreter without installing debugpy into its environment.
Executables and script paths are passed as argv, not shell command strings.
Python/.NET runtime preflight probes have a five-second deadline and a combined
1 MiB output limit. Cancellation force-terminates their owned POSIX group or
Windows Job Object and waits for process/pipe closure. On Windows 10+/Server 2016+,
a bundled native x64/ARM64 helper assigns the runtime to a non-breakaway Job
atomically at creation. Its noninheritable kill-on-close handle owns descendants
even after the runtime leader exits or closes stdio. Missing helpers or failed
containment fail closed; there is no PID scan, taskkill fallback, runtime build,
or end-user SDK prerequisite. These narrow native assets do not change Pi's
source-TypeScript entrypoint or a running Debug Session's execution-wait policy.

At source `b67073d`, [CI 34756238205](https://github.com/ian-pascoe/pi-extensions/actions/runs/34756238205)
passed all 17 preflight checks on each native Windows x64 and ARM64 runner,
including descendant cleanup, argv/PATH handling, and fail-closed containment.
The Windows payload byte-reproduction job also passed. Other expansion checks in
that run failed; this is preflight evidence, not full catalog release verification.

Missing adapters and supporting runtimes are automatically installed
on the first actual launch. That launch waits with visible tool progress and can
be cancelled; startup and discovery do not download anything. Managed binaries,
metadata, and cross-process coordination live in `<Pi agent directory>/managed-tools`,
shared with Pi LSP and Pi Formatter. Pi settings remain the configuration authority.
The private installer does not modify user PATH, shell configuration, project
manifests, or external tool installations.

First installation selects latest upstream, except .NET runtimes select the latest
compatible patch in the application's requested channel (`Disable` selects the
exact requested version). Existing versions are reused without registry refresh
until an explicit update. For Installed-only Mode, set
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

The catalog includes Microsoft `vscode-js-debug` for Node/Deno, `debugpy` for
Python, Delve for Go, CodeLLDB for Rust/C++, and NetCoreDbg for .NET. Other
standards-based adapters remain Experimental.

Expansion native proof currently covers **Linux x64 (Debian 13, kernel 6.12)**:
Deno 2.9.6 + js-debug 1.117.0, Delve 1.27.2, CodeLLDB 1.12.3 (both Rust and C++),
and NetCoreDbg 3.2.0-1092 with a private .NET 8.0.31 runtime. The tests exercise
real private acquisition with external PATH tools hidden, source breakpoints,
stack/variables/evaluation, completion and stop. Deno additionally verifies missing
dependencies, denied permissions, and no project dependency writes. These are
recorded versions, not release pins. **Other expansion cells still need native
release verification; upstream artifacts alone are not support evidence.**

Managed Go, CodeLLDB, and NetCoreDbg are unavailable on Windows ARM64; NetCoreDbg
is also unavailable on macOS x64. Delve on macOS needs a usable external
`debugserver`; Pi reports its absence rather than installing developer tools or
changing system security. CodeLLDB retains its platform package's bundled helpers.
An explicit compatible adapter remains possible on unsupported managed cells.

The shared installer and original Node/Python presets retain native x64 and ARM64
Linux, macOS, and Windows verification. The initial acquisition/launch probes passed on Ubuntu 24.04.5, macOS 15.7.9, Windows
Server 2025 x64, and Windows 11 Enterprise ARM64, using host Node 22.19.0 and
Pi 0.85.1. See the [installer's verified baselines](https://github.com/ian-pascoe/pi-extensions/tree/main/packages/pi-tool-installer#initial-verified-baselines)
for exact tool versions and verification limits. Those versions are evidence,
not release pins. macOS built-in Node/Deno launches use a short private IPC
directory to respect Unix socket path limits.

### Native verification fixtures

Run `test/expanded-presets.native.test.ts` and `test/dotnet-preset.native.test.ts`
with `PI_DAP_EXPANSION_NATIVE=1` and `--maxWorkers=1`. They create temporary
projects and acquire real private tools; no prepopulated store is required.
`PI_DAP_NATIVE_STORE` optionally retains the private store for repeat runs, and
`PI_DAP_NATIVE_MISE` can supply an already verified helper. A CI job may share its
fresh private store between serial package-native steps.

The .NET fixture acquires its own private SDK 8.0.414 for preparation only. Product
launch separately acquires a compatible runtime-only installation and never invokes
that SDK. Go fixture preparation uses the runner's native `go` compiler with
`GOTOOLCHAIN=local` and private caches; Delve's product launch does not require Go.
CI provisions native Go 1.27.1 for these fixtures instead of relying on the runner
image's compiler version. Independent shared-installer tests retain private Go
acquisition coverage.
**Test-runner prerequisites**, not product runtime dependencies:

| Native runner   | Go/Rust/C++ fixture compiler baseline                                                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux x64/ARM64 | Native-host `go`, `rustc`, `g++`, and the system C linker/development libraries.                                                                                                            |
| macOS x64/ARM64 | Native-host `go`, `rustc` and Apple's native compiler/SDK (`g++` may be the Apple Clang driver).                                                                                            |
| Windows x64     | Native-host `go`, `rustc` with its matching linker (MSVC build environment or GNU toolchain), plus x64 MinGW-w64 `g++`. C++ links compiler runtimes statically; Rust requests a static CRT. |
| Windows ARM64   | Go/CodeLLDB/NetCoreDbg cases assert declared managed unavailability before compiling; the Deno case still performs native acquisition and debugging.                                        |

Compiler version/host triples are printed and checked against the runner's native
OS/architecture. Missing or cross-target compilers fail the test rather than
silently skipping it. Compiler PATH entries are hidden before product launch,
so MinGW DLLs or a developer shell cannot accidentally satisfy adapter/runtime
closure. Known NetCoreDbg macOS x64 unavailability is tested without downloading
a runtime/SDK; other unverified cells attempt real operation rather than treating
transient failures as unsupported.

Fixtures expose their Debuggee PID through public DAP output or evaluation. Exit/paused-stop checks
wait for `ESRCH`, not merely a `terminated` snapshot. Cancelling Deno's execution
wait retains a controllable running session; explicit stop then proves process
cleanup. Prepared dependencies, missing dependencies, failed launches, and permission
denial remain separate native outcomes.

## `/dap update [id]`

```text
/dap update
/dap update javascript
/dap update python
/dap update deno
/dap update go
/dap update codelldb
/dap update dotnet
/dap update cancel
```

Updates cover only installed managed DAP presets, never unused presets or
project-local/PATH tools. Results show old/new component versions, no-change
outcomes, and per-tool failures. A failed or cancelled update retains the prior
working installation. Live Debug Sessions stay on their original executables;
the next launch resolves the updated selection. `dotnet` updates discover existing
runtime-policy selections through the shared installer, resolve compatible runtime
patches from official runtime metadata, and keep `Disable` selections exact.

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
process or protocol failures name that path. With `--no-session`, Pi provides no
session directory, so these files use a private directory under the OS temporary
directory instead. Normal session teardown removes it; forced termination may
leave temporary files behind.

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

Pi DAP supports configured stdio and TCP adapters, built-in direct-script and compiled-program profiles,
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
