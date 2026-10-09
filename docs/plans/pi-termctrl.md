# Pi Termctrl implementation plan

Status: implemented in `packages/pi-termctrl`. See "Implementation notes" at the end for decisions made during implementation.

## Outcome

Create `@ian-pascoe/pi-termctrl`, a minimal alternative to `pi-interactive-shell`. It provides:

- **Terminals**: PTY programs, driven through `@kitlangton/terminal-control`, that the agent sends input to and reads screens from.
- **Background jobs**: `bash` commands that keep running after their tool call returns.
- A `/ps` panel where the user watches and stops both.

Authorities, consulted in this order:

1. [`packages/pi-termctrl/GLOSSARY.md`](../../packages/pi-termctrl/GLOSSARY.md) for vocabulary: Terminal, Background job, Exit notification.
2. [Package ADR-0001](../../packages/pi-termctrl/docs/adr/0001-terminals-live-in-the-pi-process.md) for process memory, reload survival and session ownership.
3. [Package ADR-0002](../../packages/pi-termctrl/docs/adr/0002-replace-bash-without-a-pty.md) for the pipe-based `bash` replacement.
4. Repository ADR-0002 for source-TypeScript publishing.

This plan holds the behavioural contract. The README restates it for users once the package ships.

## Agreed behaviour

### Terminal tools

There are four tools with flat schemas and no root `anyOf`/`oneOf`. The tools are registered only when the termctrl binary resolves.

| Tool             | Parameters                                                |
| ---------------- | --------------------------------------------------------- |
| `terminal_start` | `command`, `cwd?`, `wait_ms?`, `notify?` (default `true`) |
| `terminal_send`  | `id`, `text?`, `keys?`, `wait_for_text?`, `wait_ms?`      |
| `terminal_stop`  | `id`: a Terminal id or a Background job id                |
| `terminal_list`  | none                                                      |

`terminal_stop` and `terminal_list` are also registered when only the `bash` replacement is available. The `terminal_list` result has a separate `background_jobs` section listing id, command, state and log path.

**How a Terminal starts:**

- The `command` string runs through the shell Pi's `bash` uses: the `shellPath` setting, falling back to `$SHELL` and then `/bin/sh`, called with `-c`, with `shellCommandPrefix` applied.
- The viewport comes from the `defaultViewport` setting.

**Waiting (settle):** `terminal_start` and `terminal_send` block until the Terminal settles. It settles at the first of:

- 250 ms of screen quiet;
- a `wait_for_text` match (string or regex);
- process exit;
- `wait_ms` running out.

The default `wait_ms` is:

- 2 s for `terminal_start`;
- 500 ms for `terminal_send` with input;
- 30 s for a `terminal_send` with neither `text` nor `keys`, which is a poll.

All `wait_ms` values clamp to 5 min. These numbers are fixed and are not settings.

**What `terminal_start`, `terminal_send` and `terminal_stop` return:**

- the visible screen;
- the log lines that scrolled off since the agent's previous result, within Pi's tool output limits;
- `state`;
- `exit_code` or the signal once the Terminal has exited;
- `changed: false` when the screen matches the previous result.

**`keys`:** these are termctrl `Key` names: `Enter`, `Escape`, the arrows, `Tab`, `Shift+Tab`, `Backspace`, `Delete`, `Home`, `End`, `PageUp`, `PageDown` and `Control+A`–`Z`.

**Ids:** Terminal ids are `t1`, `t2`, … in sequence, and Background job ids are `b1`, `b2`, …. Ids are never reused in a process, including across `/reload`.

**Cap:** at most 16 running Terminals and Background jobs, combined, across the whole process. Exited entries don't count. Starting one beyond the cap fails, and the error lists the caller's live entries.

**Model guidance:** tool descriptions and `promptGuidelines` only. The guideline is: use `terminal_*` for programs that need input or a screen, and `bash` for everything else.

### `bash` replacement

The replacement is active when the `replaceBash` setting is `true`, which is the default.

**Schema and execution:**

- The schema is Pi's built-in `bash` schema plus `background?: boolean`.
- Execution stays on pipes. Pi still owns how the process is spawned, killing the whole process tree, killing on Pi's own exit, Windows, truncation and rendering. See "Execution ownership" below.
- When `replaceBash` is `false`, Pi's `bash` is untouched and neither backgrounding path exists.

**A command becomes a Background job in one of two ways:**

- **`background: true`.** The call waits a fixed 2 s yield window.
  - If the command exits inside the window, the result is an ordinary foreground result and no Background job is created.
  - Otherwise the call returns a background result.
- **Ctrl+B.** It is consumed through `ctx.ui.onTerminalInput` **only while an agent `bash` call is running**, and it backgrounds every running call. At all other times it stays the editor's cursor-left.

**After a command is backgrounded:**

- Its `timeout` is cleared.
- Esc and aborting the turn no longer reach it.
- Its output so far is written to `$TMPDIR/pi-termctrl/<id>.log`, and later output is appended only to that file.

**The background result:**

- says "moved to the background as b<n>";
- includes the output so far, truncated with Pi's exported `truncateTail`;
- gives the log path.

The agent reads the log with `read` and stops the job with `terminal_stop {id: "b<n>"}`.

**Output contract.** The replacement's `outputSchema` is Pi's `bashOutputSchema` with two changes:

- `exit_code` becomes optional, and is absent only when the command was backgrounded;
- a new optional `background: { id, log_path }` field.

Foreground structured results are unchanged. `codemode` therefore declares `bash` with this schema whenever `replaceBash` is on.

**Execution ownership.** Our `BashOperations.exec` wraps Pi's `createLocalBashOperations().exec`. The wrapper:

- Passes Pi an `AbortController` we own, plus a `timeout` of `undefined`.
- Forwards the tool call's `signal` to that controller until the command is backgrounded.
- Runs `timeout` itself. When it fires, the wrapper aborts the controller and rejects with `Error("timeout:N")`, so Pi's `execute` writes the built-in "Command timed out" text.
- Tees `onData` into the in-memory buffer and, once the command is backgrounded, into the log only. The inner accumulator and its temp file stop growing.
- Records the exit code when Pi's `exec` settles.

The outer `execute` races the inner execute against backgrounding. After backgrounding, it drops the inner execute's `onUpdate` calls and its eventual result. A Background job's PID is never known, so jobs are identified by id.

**Log files:** a Background job's log is deleted when the job is stopped, when the user removes it in `/ps`, or when Pi shuts down for any reason other than reload.

`bash` calls made from `codemode` through `ctx.executeTool` go through the same wrapper. Both `background: true` and Ctrl+B apply to them. User `!` commands and auto-backgrounding are out of scope.

### Exit notifications

An Exit notification is sent when a Terminal or Background job exits and both of these hold:

- the agent hasn't already seen the exit in a `terminal_*` result or stopped the process itself;
- `notify` wasn't `false` when the Terminal was started.

**Content:**

- the id;
- the command;
- the exit code or signal;
- the duration;
- the last `exitTailLines` lines of the final screen (Terminal) or the log (Background job).

**Batching:** exits that happen in the same tick go into one message.

**Delivery:**

- It uses `pi.sendMessage({customType, content, display: true, details}, {triggerTurn: true, deliverAs: "steer"})`. This steers the agent while it's working and starts a turn when it's idle.
- It has a compact message renderer.
- It goes only to the **owner** session.
- If the owner session is unbound (between reload shutdown and `session_start`), the notification is queued and flushed when the session binds again.

### Lifecycle, ownership, stopping

**Registry:**

- The **registry** lives under one versioned `globalThis` key. It holds the SDK driver, every Terminal handle, every Background job child and the id counter.
- Every entry has an **owner**: the `ctx.sessionManager.getSessionId()` of the Pi session that started it, recorded when the entry is created. Agent tools, Exit notifications and shutdown act only on the owner's entries. This matters because pi-minimal-subagents runs child agents in the same process.

**Shutdown and reload:**

- `session_shutdown` with reason `reload` keeps everything running.
- Any other reason stops the owner's entries.
- If a reload finds a registry version it doesn't recognize, it stops every entry in that registry and starts fresh. There is no migration.

**Child listeners:**

- Child-process and driver listeners call registry methods only.
- The current module rebinds those methods on load, so stale `pi`/`ctx` closures never run.

**Driver failure:** if the driver child dies, every one of its Terminals is marked exited and the next `terminal_start` starts a new driver.

**Stopping** works the same everywhere: `terminal_stop`, `k` in `/ps`, and shutdown.

- For a Terminal, call termctrl `session.stop()`. If the Terminal is still alive after 3 s, send `SIGKILL`.
- For a Background job, abort its controller. Pi's `killProcessTree` sends `SIGKILL` to the process group (`taskkill /T` on Windows).

**Retention:** an exited entry stays readable, and listed in `terminal_list` and `/ps`, until one of these happens:

- the agent calls `terminal_stop`;
- the user removes it in `/ps`;
- the owner session shuts down.

### `/ps` and footer

**`/ps` overlay:**

- A list of every entry in the process, with columns for kind, id, owner (root or child agent), command, state and age.
- A live preview of the selected entry: a Terminal's screen or the tail of a Background job's log.
- Keys: `↑/↓` to select, `k` to stop with no confirmation, `x` to remove an exited entry, `esc` to close.

**Footer:** `ctx.ui.setStatus` shows `N running` while anything is live and clears when nothing is.

**Non-TUI modes:** the UI is guarded by `ctx.hasUI`. RPC and print modes still get the tools and notifications.

### Settings

Settings live under `settings.termctrl`, layered the way pi-dap's are:

```json
{
  "termctrl": {
    "replaceBash": true,
    "defaultViewport": { "cols": 120, "rows": 40 },
    "exitTailLines": 20
  }
}
```

Unknown keys produce warnings. There are no other settings, config files or persistence.

### Platform

**Dependency:** `"@kitlangton/terminal-control": "^1.2.1"` as a regular dependency.

- Its platform `optionalDependencies` ship the `termctrl` binary for darwin-arm64/x64 and linux-arm64/x64-gnu.
- Pi's installers keep optional dependencies, so users install nothing extra.

**When no binary resolves** (Windows, musl, `omit=optional`):

- Register no Terminal tools and show one diagnostic.
- The `bash` replacement, `terminal_stop` and `terminal_list` keep working, on every platform Pi's `bash` supports.

## Verified integration points

The installed Pi is the runtime authority. Its path is `node_modules/@earendil-works/pi-coding-agent` (0.99.1), shortened to `$P` below. `.repos/pi` is 0.99.2, with identical APIs for these seams.

| Need                  | Seam                                                                                                                            | Constraint                                                                                                                                                                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bash` override       | `pi.registerTool({ ...createBashToolDefinition(cwd, opts), parameters, execute })`                                              | Same-name registration replaces the built-in (`examples/extensions/tool-override.ts`, `sandbox/index.ts`). Spread the built-in definition to keep its snippet, guidelines, renderers and `constrainedSampling`.                                                        |
| Pipe execution        | `createLocalBashOperations().exec` (`bash.js:50-125`), wrapped by our `BashOperations`; built-in `execute` at `bash.js:174-310` | Pi's `exec` keeps the child process to itself: it calls `trackDetachedChildPid`, and `killProcessTree` sends SIGKILL. Its `timeout` can't be cleared, so the wrapper owns `timeout`. Pi's `execute` turns `aborted` and `timeout:N` rejections into its standard text. |
| Output contract       | `bashOutputSchema`, extended as described above                                                                                 | Pi never checks structured content against the schema. `codemode` uses the schema only for its type declaration and returns `structuredContent` to scripts (`extensions/codemode/execute.js:172-180`).                                                                 |
| Owner identity        | `ctx.sessionManager.getSessionId()`                                                                                             | A fresh id per session (`session-manager.js:691-695`). In-process child agents have their own `SessionManager`. The id is stable across `/reload` and changes only around a `session_shutdown` for fork, new or resume.                                                |
| Ctrl+B                | `ctx.ui.onTerminalInput`, `matchesKey` from `@earendil-works/pi-tui`                                                            | TUI-only, and runs before focus routing. `ctrl+b` is `tui.editor.cursorLeft` and not reserved. Subscribe only while a call runs.                                                                                                                                       |
| Exit notifications    | `pi.sendMessage(..., {triggerTurn, deliverAs})`, `agent-session.js:1714-1752`                                                   | Pattern: `pi-minimal-subagents/src/minimal-subagents-extension.ts:184-196`. A stale `pi` throws after reload (`runner.js:482-490`).                                                                                                                                    |
| Reload                | `agent-session.js:2867-2892`; jiti `moduleCache:false` (`loader.js:460-464`)                                                    | Same Node process with fresh module instances, and `globalThis` survives. Shutdown `reload` completes before the new `session_start`.                                                                                                                                  |
| Shutdown reasons      | `session_shutdown.reason`: `quit`, `reload`, `new`, `resume`, `fork`                                                            | Pi kills its tracked `bash` children only when Pi itself exits on a signal. The extension stops Terminals and Background jobs on every reason except reload.                                                                                                           |
| `/ps` overlay         | `pi.registerCommand`, `ctx.ui.custom(..., {overlay: true, overlayOptions})`                                                     | Pattern: `pi-minimal-subagents/src/minimal-subagents-status-panel.ts` (refresh interval, `handleInput`, overlay sizing).                                                                                                                                               |
| Settings              | `SettingsManager`                                                                                                               | Pattern: `pi-dap/src/pi-dap-settings.ts`.                                                                                                                                                                                                                              |
| Provider-safe schemas | Flat TypeBox objects                                                                                                            | Anthropic, OpenAI strict mode and DeepSeek reject root unions (see `pi-lsp/src/lsp-tool-contract.ts`).                                                                                                                                                                 |
| termctrl SDK          | `TerminalControl.make()`, `terminal.launch()`, `session.screen` / `keyboard` / `logs` / `waitForExit` / `stop()`                | The SDK is a JSON-lines client for one `termctrl driver` child. It has no session listing and no push events, so the preview polls `screen.text()`. Read its `docs/typescript-client.md`.                                                                              |

## Implementation sequence

Work test-first. Each step ends **green** on its own tests before the next step starts.

### 1. Scaffold the package

- Copy the package layout from `packages/pi-dap`: `package.json`, `tsconfig.json`, `LICENSE`, `src/index.ts`, `test/`.
- Add the dependency on `@kitlangton/terminal-control`, plus only the Pi peers actually imported.
- Add `skills/pi-termctrl/SKILL.md`. It is a short **configuration and diagnosis** skill in the pi-dap style, which `scripts/check-package-packs.mjs` requires of every extension. It doesn't teach the model how to use the tools.
- Register the package in the root `package.json` `pi.extensions` and `pi.skills`, the root README tables, and `GLOSSARY-MAP.md` (already added).
- Update the fixed counts in `scripts/check-package-packs.mjs` and `scripts/check-git-install.mjs`, currently 14 manifests, and reconcile them against the checkout.
- Run `pnpm install` to refresh the lockfile.

**Complete when:** `pnpm --filter @ian-pascoe/pi-termctrl typecheck`, `pnpm pack:check` and `pnpm git-install:check` pass with an empty extension.

### 2. Settings and binary resolution

- Parse `settings.termctrl`, with defaults and unknown-key warnings.
- Resolve the binary with `resolveTerminalControlBinary()`, honouring `TERMCTRL_BINARY`. If it doesn't resolve, report one diagnostic and register no Terminal tools.

**Complete when:** settings tests cover defaults, layering, invalid values and unknown keys, and a resolution test covers the binary-missing path.

### 3. Registry

- Implement the versioned `globalThis` registry: owners, the id counter, the cap, retention, the Exit-notification queue and owner binding.
- Implement stopping for both kinds, version-mismatch teardown, and driver-death handling.
- Child and driver listeners call registry methods only.

**Complete when:** unit tests against a fake driver and fake children cover:

- owner isolation;
- reload survival with a fresh module instance;
- the stale-`pi` queue being flushed on rebind;
- version-mismatch teardown;
- the cap error listing live entries;
- id monotonicity across reloads;
- same-tick notification batching;
- suppression of exits the agent has already seen.

### 4. Terminal tools

- Implement the four tools over the registry and the SDK: settle semantics, scrolled-off lines from tracking the `logs` cursor per Terminal, the `changed` flag, and shell resolution.
- Add the message renderer for Exit notifications.

**Complete when:**

- Fake-driver tests cover every settle exit path, `wait_ms` defaults and clamping, poll behaviour, truncation and `keys` validation.
- **Real-binary** integration tests drive a REPL (`python3` or `node`), a full-screen TUI (`less` or `vim`), a long-running process with output and a poll, a `wait_for_text` match, and `terminal_stop` escalation.
- The real-binary tests are required on Linux x64 CI and skipped only when no platform binary exists.

### 5. `bash` replacement

- Wrap Pi's `bash` definition and `exec` as described under "Execution ownership".
- Extend the output schema.
- Implement `background: true` with the 2 s yield window, Ctrl+B through `onTerminalInput`, log files, timeout clearing and abort isolation.
- Register Background jobs in the registry.

**Complete when:**

- Tests prove that foreground results are byte-identical to the built-in for success, non-zero exit, timeout, abort and truncation.
- Tests prove that `background: true` behaves correctly on both sides of the yield window.
- Tests prove that Ctrl+B backgrounds every running call and nothing else, and that cursor-left still works when idle.
- Tests prove that Esc after backgrounding leaves the job alive, and that `terminal_stop` kills the whole process tree.
- Tests prove that after backgrounding, the inner accumulator stops receiving data and no inner `onUpdate` reaches Pi.
- Tests prove that a `codemode` script's `tools.bash({background: true, ...})` gets the typed background result.
- Tests prove that log files are created and deleted as specified.
- Tests prove that `replaceBash: false` leaves Pi's `bash` registered untouched.

### 6. `/ps` and footer

- Build the overlay and the live preview.
- Add the `k`/`x`/`esc` keys and the footer status.
- Clean up on dispose, and handle reload, which rebuilds the UI from the new `ctx`.

**Complete when:** component tests cover rendering at narrow and wide widths, key handling, the preview for both kinds, an empty state, and timers being cleared on close and on reload.

### 7. Cache proofs and coexistence

- Write offline SDK integration tests, following [plan 003](003-preserve-active-tool-order.md)'s approach. They compare the **ordered tool definitions and the system prompt**, serialized, across these cases:
  - consecutive turns;
  - `/reload`;
  - starting and stopping Terminals and Background jobs;
  - Exit notifications arriving;
  - `replaceBash` both on and off;
  - `codemode`'s declaration of `bash`, when `codemode` is enabled;
  - the binary-missing configuration.
- Write a coexistence test using pi-minimal-subagents fixtures. A child agent starts a Terminal and a Background job and then shuts down. The parent's entries survive, the child's are stopped, and no notification crosses sessions.

**Complete when:** every comparison is byte-equal where the configuration is unchanged.

### 8. Docs, release, live verification

- Write the README: the behavioural contract, settings, platform support, and the `bash` conflict with other extensions that register `bash`. ADR-0002 records that conflict.
- Add a Changeset for `@ian-pascoe/pi-termctrl` per [`docs/releases.md`](../releases.md).
- Run `pnpm verify`, `pnpm pack:check`, `pnpm git-install:check` and `pnpm changeset:status`.
- Drive a real Pi TUI with the `terminal-control` skill, using an isolated stub model or fixture session. Record evidence for:
  - Ctrl+B mid-command;
  - `background: true`;
  - an Exit notification starting a turn while idle;
  - a Terminal running a REPL;
  - `/ps` preview and kill;
  - `/reload` with live entries;
  - quit stopping everything.

**Complete when:** automated checks pass and live evidence covers each listed behaviour. Report any live check that couldn't be run as a gap.

## Stop conditions

Stop and ask the user before continuing if any of these happens:

- **Foreground parity.** Wrapping Pi's `exec` can't keep foreground output byte-identical to the built-in, including timeout and abort text.
- **Ctrl+B delivery.** `onTerminalInput` can't reliably see Ctrl+B while a tool runs.
- **Reload survival.** Surviving `/reload` needs something beyond the `globalThis` registry, such as patching Pi internals.
- **SDK gaps.** The termctrl SDK can't deliver settle semantics or scrolled-off lines without driving the CLI.
- **Cache proofs.** A cache-proof comparison differs for any reason other than an intentional configuration change.

## Boundaries

The following are out of scope:

- human attach/takeover of a Terminal;
- recording, video and screenshots;
- mouse input;
- resize;
- raw byte input;
- monitor or trigger modes;
- spawning agent CLIs;
- persistence across Pi restarts;
- Windows or musl support;
- a model-usage skill;
- intercepting user `!` commands;
- auto-backgrounding;
- graceful `SIGTERM` stopping of Background jobs, because Pi's tree-kill owns that.

## Implementation notes

Decisions made while implementing, where the plan left room or the SDK forced a choice:

- **Driver requests are serial.** The termctrl driver answers one request at a time across all of its Terminals, so a long `waitForText` or `waitForExit` would block every other Terminal and the `/ps` preview. Settling therefore polls short `status` and `capture` requests every 50 ms instead of awaiting long SDK waits. Exits that no tool call is waiting on are found by a 500 ms watcher over idle running Terminals; driver death is detected from the SDK's "driver exited/closed" errors on those polls.
- **Settle details.** With `wait_for_text`, quiet alone does not settle the wait, otherwise any pause would end it early. A poll (no `text` or `keys`) settles on quiet only after new output appears, so an idle Terminal is polled for the full `wait_ms`. `wait_for_text` written as `/source/flags` is a regex; anything else is a literal substring.
- **Scrolled-off lines** come from `session.logs.text()`. Each Terminal keeps a cursor at the start of the screen in its previous result, so lines the agent saw on screen are returned again once they scroll off, in their final form. termctrl keeps limited scrollback and drops its oldest lines, so the cursor is found again by searching for the last lines before it. When they are gone (dropped unreported, or `clear`), every retained line is returned with `output_missing: true` and a notice; the first result of a Terminal cannot detect drops ([anomalyco/terminal-control#36](https://github.com/anomalyco/terminal-control/issues/36)). Full output of the program is a non-goal for Terminals; `bash` covers it.
- **Output limits.** A Terminal result is limited to Pi's 2000 lines or 50 KB: the screen is kept first, from its bottom, and the newest scrolled-off lines fill the rest. A truncated result writes every line to a full output file, as Pi's `bash` does.
- **Terminal shell.** Terminals use Pi's own `getShellConfig(shellPath)`, the exact shell Pi's `bash` uses, rather than `$SHELL`, so `shellCommandPrefix` keeps working.
- **SIGKILL escalation.** termctrl never reports a Terminal's pid. Each Terminal is launched through a `/bin/sh` wrapper that writes `$$` to a temporary pid file and `exec`s the command, so the pid is known and a stuck stop can `SIGKILL` its process group.
- **Log paths** are `$TMPDIR/pi-termctrl/<pid>-<id>.log`; the Pi process id keeps concurrent Pi processes from sharing `b1.log`.
- **`/ps` `k`** stops an entry but keeps it listed as exited, and the owning agent gets an Exit notification, because the agent did not stop it. `x` then removes it.
- **Tool registration timing.** `terminal_start`, `terminal_send`, `terminal_stop` and `terminal_list` register when the extension loads if the binary resolves, so hosts that check a session's tools before `session_start` (Minimal Subagents verifies a Child Agent's grants then) see them. The `bash` replacement, and `terminal_stop`/`terminal_list` when the binary is missing, depend on settings and register at `session_start`.
- **`wait_for_text` baseline.** Text already on the screen before a `terminal_send` counts only after the screen changes, so a stale match cannot settle the call before the input takes effect. The quiet period of `terminal_start` begins after the Terminal launches, so a cold driver start cannot settle it on a blank screen.
- **`terminal_stop` result.** For a Terminal it carries the final screen, the scrolled-off lines, `state`, the exit and `changed`, like the other Terminal tools; for a Background job it carries the job's recent output instead of a screen. Both share one flat output schema with optional fields.
- **User stops keep logs.** A job stopped with `k` in `/ps` keeps its log until the user removes it with `x` or its session shuts down, so it stays readable like any exited entry.
- **Temporary files.** ADR-0001 records the job logs, pid handoff files and full output files as the package's only writes outside the session transcript.
- **Registry version.** Any change to the shape of the process-wide registry state bumps `REGISTRY_VERSION`, so a reloaded module tears down older state instead of adopting it.
