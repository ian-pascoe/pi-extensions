# Add the `@ian-pascoe/pi-dap` package

**Status:** Implemented

## Outcome

Add a source-TypeScript Pi extension that exposes one strict `dap` tool and owns one configured
Debug Session at a time. Node/TypeScript through Microsoft `vscode-js-debug` is the sole Supported
Adapter workflow; other standards-based adapters remain experimental.

Read before implementation:

- [`../../AGENTS.md`](../../AGENTS.md)
- [`../../CONTEXT-MAP.md`](../../CONTEXT-MAP.md)
- [`../../packages/pi-dap/CONTEXT.md`](../../packages/pi-dap/CONTEXT.md)
- [`../../packages/pi-dap/docs/adr/0001-own-a-narrow-dap-client.md`](../../packages/pi-dap/docs/adr/0001-own-a-narrow-dap-client.md)
- repository ADRs in [`../adr/`](../adr/)
- [`../agents/domain.md`](../agents/domain.md)
- Pi's extension documentation at
  [`../../.repos/pi/packages/coding-agent/docs/extensions.md`](../../.repos/pi/packages/coding-agent/docs/extensions.md)
- the [Debug Adapter Protocol specification](https://microsoft.github.io/debug-adapter-protocol/specification)

Use the package glossary's terms in identifiers, tests, errors, and documentation.

## Boundaries

- Register one model-facing `dap` tool; add no command, widget, custom rendering, or debugger panel.
- Support one active Debug Session per Pi conversation session, with no persisted runtime state.
- Support configured stdio and TCP Debug Adapters. Provide no discovery, installer, or built-in
  adapter catalog.
- Read only the `dap` key from Pi's trust-aware global and project settings.
- Support Linux and Node/TypeScript initially. Treat other platforms and adapters as experimental.
- Publish source TypeScript following ADR-0002: no `dist`, build script, `main`, `types`, or
  `exports`.
- Prepare `@ian-pascoe/pi-dap@0.1.0`; add no bootstrap Changeset and run no publish command.

V1 operations are exactly:

```text
launch
set_breakpoints
continue
next
step_in
step_out
pause
stack
variables
evaluate
status
stop
```

V1 excludes attach, restart, function/data/instruction breakpoints, hit counts, logpoints, memory,
disassembly, modules, user-requested child Debug Sessions, raw DAP requests, `launch.json`,
WebSocket, and persistence. The Supported `vscode-js-debug` workflow may open exactly one
adapter-owned primary target channel against its existing adapter process.

## Runtime contract

### Settings

Parse the following shape with TypeBox:

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
        "args": ["path/to/dapDebugServer.js", "$PORT"],
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

Rules:

- Adapter Definitions require `command` and `transport`; `args` and `environment` default empty.
- Transport is `"stdio"` or `{ "type": "tcp", "host"?, "port"? }`. TCP host defaults to
  `127.0.0.1`; missing or zero port allocates a local port.
- Replace every `$PORT` substring in TCP adapter arguments and inject the selected port as the
  `PORT` environment variable. Reject `$PORT` in a stdio Adapter Definition.
- Launch Profiles require `adapter` and an opaque JSON-object `arguments`.
- Global/project Adapter Definition and Launch Profile maps merge by ID. A project entry replaces
  the complete global entry; `null` removes it. Invalid project replacements still shadow global
  entries.
- Timeouts merge by field and default to the values above.
- Quarantine invalid entries individually and report path-qualified warnings at `session_start`;
  unrelated valid entries remain usable.
- Profiles referencing absent or invalid adapters are invalid.
- Missing `dap` settings produce no configured adapters and do not disable the extension.
- Pi `/reload` is the configuration reload path.

### Tool inputs

Use one strict TypeBox discriminated union:

- `launch`: optional `profile` only when exactly one valid profile exists; optional `program`,
  `args`, and `cwd` replace same-named profile arguments. Resolve tool-provided relative `program`
  and `cwd` values against Pi's project working directory.
- `set_breakpoints`: `file_path` plus the complete desired list of `{ line, condition? }`. Lines
  are one-based; `[]` clears that file.
- `stack`: optional `thread_id`, `start`, and `count`; defaults to the stopped thread, start `0`,
  count `20`.
- `variables`: exactly one of `frame_id` or `variables_reference`, with optional `start` and
  `count`; count defaults to `100`.
- `evaluate`: `expression` and optional `frame_id`; defaults to the top Stack Frame.
- Remaining operations need no additional input.

Resolve relative breakpoint paths against Pi's project working directory. Desired Breakpoints
survive `stop` and later launches in the same Pi conversation session.

### State and results

Model the lifecycle as an exhaustive tagged union. Enforce:

- `launch` fails while a Debug Session is active.
- `continue`, stepping, stack inspection, variables, and evaluation require a stopped Debuggee.
- `pause` requires a running Debuggee.
- `status` and `stop` are idempotent.
- Execution operations wait until stop, exit, cancellation, or `executionMs`. Timeout returns
  `running`; request/startup/shutdown timeout is an error.
- Natural exit cleans up resources and leaves a terminal snapshot available through `status` until
  the next launch.
- A failed active breakpoint update preserves the prior Desired Breakpoint state.

Every successful result contains compact text and schema-validated details with applicable
adapter/profile IDs, state, stop reason, thread/Stack Frame IDs, exit code, output truncation, and
Result Spill path. Every operation drains currently unread Debuggee output into its readable text;
`status` provides the same drain after an earlier execution wait returned `running`.

### Protocol and process lifecycle

Implement only the required DAP client behavior:

1. Start the configured Debug Adapter.
2. Connect over stdio or TCP.
3. Send `initialize` and advertise headless `runInTerminal` support.
4. Register the `initialized` waiter, send `launch`, apply Desired Breakpoints after `initialized`,
   send `configurationDone` when supported, and await the launch response.
5. Track `output`, `stopped`, `continued`, `exited`, and `terminated` events.
6. Correlate requests and responses while preserving cancellation and request timeouts.

Requirements:

- Parse inbound envelopes before they enter session logic. Treat malformed headers, malformed
  JSON, invalid required fields, frames over 8 MiB, and unexpected process exit as fatal protocol
  failures.
- TCP allocation binds an OS-selected port, releases it immediately before spawn, substitutes
  `$PORT`, then retries connection until `startupMs`.
- Adapter startup uses `shell: false`, Pi's project cwd, inherited environment, and configured
  overrides; `null` environment values remove inherited keys.
- Support `runInTerminal` by spawning the requested command headlessly, respecting its cwd,
  environment, and shell-interpretation flag. Capture its output and return its PID.
- Accept only `vscode-js-debug`'s first `pwa-node` primary-target `startDebugging` request on the
  existing TCP adapter process; reject unrelated, second, and nested requests.
- On `stop`, launch cancellation, adapter failure, or Pi shutdown: attempt DAP `terminate`, then
  `disconnect`, then terminate owned Linux process groups with `SIGTERM` followed by `SIGKILL`
  within `shutdownMs`.
- Execution-wait cancellation stops only the wait and retains a recoverable live Debug Session.
- Retain at most 1 MiB of unread Debuggee output and report discarded older bytes. Apply Pi's
  2,000-line/50-KB visible limit and write the complete retained result to a Result Spill when
  truncated.
- Retain the latest 1 MiB of adapter stderr in the session directory and name its path in
  process/protocol errors.
- Remove session files during `session_shutdown`.

Translate process, transport, protocol, timeout, and state failures into package-owned typed
errors; render them with a stable `Pi DAP:` prefix at the tool boundary.

## Intended module map

| File                         | Sole owner                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------- |
| `src/index.ts`               | Thin default extension export                                                                     |
| `src/pi-dap-settings.ts`     | Settings schemas, defaults, layer merging, and validation                                         |
| `src/dap-protocol-client.ts` | Adapter process, stdio/TCP framing, requests, events, reverse requests, and transport shutdown    |
| `src/dap-session.ts`         | Debug Session state, Desired Breakpoints, launch choreography, execution, and inspection          |
| `src/dap-tool.ts`            | Strict tool union, operation dispatch, structured details, and readable result formatting         |
| `src/dap-session-files.ts`   | Bounded adapter logs, Debuggee output retention, and Result Spills                                |
| `src/pi-dap-extension.ts`    | Pi registration, settings/session construction, lifecycle ownership, and conversation-level state |

Keep DAP types beside their owner and import protocol declarations from `@vscode/debugprotocol`.
Add no generic `types.ts`, `config.ts`, `utils.ts`, pass-through interface, or adapter abstraction
with one implementation. Split a listed owner only if it becomes internally incohesive.

## Implementation sequence

### 1. Establish the package shell and settings parser

Record:

```bash
git status --short
git rev-parse HEAD
pnpm verify
pnpm changeset:status
```

Expected initial changes are `CONTEXT-MAP.md`, the DAP context, package ADR, and this plan. Stop if
unrelated source/configuration changes exist.

Create the package metadata, strict NodeNext `tsconfig.json`, MIT license, README shell, inert
entrypoint, and package load test.

Dependencies:

- runtime/type dependency: `@vscode/debugprotocol@^1.68.0`;
- development-only Supported Adapter:

```json
"vscode-js-debug": "https://github.com/microsoft/vscode-js-debug/releases/download/v1.117.0/js-debug-dap-v1.117.0.tar.gz"
```

Use wildcard peers for Pi Coding Agent and TypeBox. Let `pnpm install` update the lockfile.

Implement settings parsing first. Test absent settings, defaults, global/project merging, `null`
removal, invalid replacement shadowing, untrusted project exclusion, timeout overrides, transport
validation, `$PORT` misuse, and missing adapter references. Use real temporary settings files; use
no module mocks.

**Complete when:** the entrypoint loads without starting a process, every settings value becomes
either a parsed application value or a precise warning, and the package typechecks.

### 2. Build a tested DAP Protocol Client tracer

Create tiny real child-process fixtures for stdio and TCP. Implement framing, request correlation,
events, reverse requests, timeout/cancellation, startup, and shutdown through
`dap-protocol-client.ts`.

Tests cover:

- fragmented and coalesced frames;
- arbitrary chunk-boundary framing, with a `fast-check` property test when it finds cases beyond
  the examples;
- successful and failed responses;
- malformed/missing headers and malformed JSON;
- 8-MiB frame rejection;
- startup/request timeout and cancellation;
- adapter stderr and unexpected exit;
- TCP `$PORT` substitution, environment injection, fixed/dynamic ports, and connection retry;
- awaited graceful shutdown followed by forced termination.

Use faithful real-process fixtures and no module mocks.

**Complete when:** both transports pass the same observable protocol contract and every fixture
process, socket, timer, listener, and pending waiter is closed after success or failure.

### 3. Implement the Debug Session vertical slice

Implement the tagged state machine and launch sequence through the fake adapters before adding the
Pi tool.

Cover:

- pre-launch Desired Breakpoints and configuration ordering;
- source-breakpoint replacement and conditional breakpoints;
- stopped/running/terminated transitions;
- continue, next, step-in/out, and pause;
- stopped-thread stack retrieval and paging;
- Stack Frame scopes, child variables, paging, and evaluation;
- execution timeout returning `running`;
- invalid operation transitions;
- natural exit and retained terminal snapshot;
- launch while active;
- failed breakpoint mutation preserving prior state;
- output accounting and truncation metadata;
- `runInTerminal` output/process cleanup;
- the one Supported Adapter primary target channel and rejected unrelated/nested
  `startDebugging`;
- launch cancellation, execution-wait cancellation, adapter crash, and shutdown cleanup.

**Complete when:** the Debug Session module performs the full agreed workflow against faithful fake
adapters without Pi framework state.

### 4. Register the `dap` tool and Pi lifecycle

Implement `dap-tool.ts`, session files, and `pi-dap-extension.ts`.

- Register exactly the agreed operation union and re-parse input inside `execute()`.
- Read settings once at `session_start` and start adapters lazily on `launch`.
- Forward Pi's AbortSignal.
- Normalize structured details through an owning schema.
- Apply Pi output truncation and Result Spills.
- Await cleanup during `session_shutdown`.

Test through Pi's real `ExtensionRunner`/resource-loader seam. Prove entrypoint load is inert,
warnings surface at session start, every operation dispatches correctly, invalid branch arguments
fail before effects, output spills are readable, `/reload` replaces settings, and shutdown leaves
no process or session directory.

**Complete when:** every caller-visible operation is tested through the registered tool and
lifecycle hooks.

### 5. Prove the Supported Adapter workflow

Use the pinned `vscode-js-debug/src/dapDebugServer.js` and a temporary TypeScript fixture runnable
by Node 22. Keep the fixture to erasable TypeScript syntax supported by the repository's runtime.

Exercise:

1. launch through TCP;
2. stop on a TypeScript source breakpoint;
3. inspect stack and variables;
4. evaluate an expression;
5. continue to normal exit;
6. retrieve terminal status and output;
7. confirm adapter and Debuggee processes are gone.
8. launch again, call `stop`, and confirm the adapter and Debuggee processes are gone.

Keep setup deterministic and offline after `pnpm install`.

**Complete when:** the real Node/TypeScript test fails without the implementation and passes
through the same public Debug Session/tool interface used in production.

### 6. Finish repository integration

Update every repository authority:

- root `package.json` ordered extension list;
- `.pi/settings.json` signed workspace/Git filters;
- `.pi/settings.json` DAP timeout defaults, Node Adapter Definition, and Node Launch Profile using
  `packages/pi-dap/node_modules/vscode-js-debug/src/dapDebugServer.js`;
- root README package table, selectable path, prerequisite, and focused check;
- `test/extension-entrypoints.test.ts` path/count;
- `test/project-extension-overrides.test.ts` count;
- `scripts/check-package-packs.mjs` workspace count/messages;
- `scripts/check-git-install.mjs` extension count/messages;
- `docs/releases.md`: eight scoped bootstrap packages and ten trusted-publishing packages;
- `pnpm-lock.yaml`.

Complete the package README with installation, exact settings schema, merge rules, operations,
state preconditions, Supported/Experimental Adapter distinction, Node example, output limits,
lifecycle, and the explicit V1 boundary. Document that Debug Adapter executables are user-managed;
the repository-only `vscode-js-debug` development dependency is not part of the published package.

Add no bootstrap Changeset. Ensure entrypoint loading and `session_start` remain inert when the
development-only adapter is absent, so packed and clean production Git installs still load.

**Complete when:** workspace, packed npm tarball, and clean Git installation all load the tenth
source entrypoint, tracked settings select the local package and Node smoke profile, and the packed
package excludes `vscode-js-debug`.

### 7. Run the proof gate

Run:

```bash
pnpm format
pnpm --filter @ian-pascoe/pi-dap typecheck
pnpm --filter @ian-pascoe/pi-dap test
pnpm test:load
pnpm pack:check
pnpm git-install:check
pnpm verify
pnpm changeset:status
git diff --check
git status --short
```

Inspect the final diff and confirm:

- exactly one `dap` tool and one active Debug Session;
- exactly the twelve agreed operations;
- no adapter catalog/discovery, `launch.json`, attach, raw request, advanced breakpoint,
  persistence, WebSocket, or UI code;
- every settings, tool, and protocol input is parsed;
- every process, socket, timer, listener, waiter, file, and session state has one cleanup owner;
- the real Node/TypeScript integration passes;
- package counts, root lists, project settings, release docs, lockfile, and tests agree;
- no publish command ran.

**Complete when:** `pnpm verify` is green, the packed production package excludes
`vscode-js-debug`, all lifecycle checks are green, and the working tree contains only the approved
package/docs/plan and required root integration.

## Pause

Do not begin implementation until this plan is reviewed and explicitly approved in a later turn.
