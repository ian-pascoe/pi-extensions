# @ian-pascoe/pi-termctrl

Interactive Terminals, Background jobs, and a `/ps` panel for
[Pi](https://github.com/earendil-works/pi). It is a minimal alternative to
`pi-interactive-shell`.

- **Terminals** are PTY programs, such as REPLs, TUIs and prompts, that the agent
  drives by sending input and reading the screen. They run through
  [`@kitlangton/terminal-control`](https://www.npmjs.com/package/@kitlangton/terminal-control).
- **Background jobs** are `bash` commands that keep running after their tool
  call returns.
- **`/ps`** lists both, previews them live, and stops them.

## Install

```bash
pi install npm:@ian-pascoe/pi-termctrl
# or
pi install git:github.com/ian-pascoe/pi-extensions
```

For a local checkout, run `pi -e ./packages/pi-termctrl/src/index.ts`.

## Terminal tools

| Tool             | Parameters                                                |
| ---------------- | --------------------------------------------------------- |
| `terminal_start` | `command`, `cwd?`, `wait_ms?`, `notify?` (default `true`) |
| `terminal_send`  | `id`, `text?`, `keys?`, `wait_for_text?`, `wait_ms?`      |
| `terminal_stop`  | `id`: a Terminal id (`t1`) or Background job id (`b1`)    |
| `terminal_list`  | none                                                      |
| `terminal_wait`  | `ids?`, `wait_ms?` (default and maximum 300000)           |

`terminal_start` runs `command` through the shell Pi's `bash` uses (the
`shellPath` setting, otherwise Pi's default bash), applies `shellCommandPrefix`,
and opens a PTY sized by `termctrl.defaultViewport`. A relative `cwd` resolves against
the session's directory. A `cwd` that is missing or not a directory fails with an
error naming the resolved path.

`terminal_start` and `terminal_send` wait until the Terminal **settles**: at the
first of 250 ms of screen quiet, a `wait_for_text` match, process exit, or
`wait_ms` running out. `wait_for_text` is a literal substring, or a regex when
written as `/source/flags`; with `wait_for_text`, quiet alone does not end the
wait, and text already on the screen before `terminal_send` counts only after
the screen changes. Default waits are 2 s for `terminal_start`, 500 ms for `terminal_send`
with input, and 30 s for a `terminal_send` with neither `text` nor `keys` (a
poll, which settles on quiet only after new output). Every `wait_ms` clamps to
5 minutes.

Calls to one Terminal run one at a time, in arrival order: a parallel batch of
`terminal_send` calls each types, presses keys, and settles before the next
starts, so every result shows its own call's screen; a `terminal_stop` waits its
turn too, then reports what the calls ahead of it left. A call queued behind a
stop finds the Terminal gone. Calls to different Terminals stay concurrent. Aborting a waiting
call removes it without affecting the running one.

Results say why the wait ended in `settle_reason` (`matched`, `timeout`, `quiet`
or `exited`) and in their first line, such as `t1 running · settled: timeout`; a
`wait_for_text` that timed out adds that the pattern was not seen. Polls report
their reason too.

Sending `text` or `keys` to an exited Terminal is an error that names its exit
code or signal; a poll (neither `text` nor `keys`) still returns its final screen.

Results contain the visible screen, the log lines that scrolled off since the
agent's previous result, `state`, `exit_code` or `signal` once exited, and
`changed: false` when the screen matches the previous result. A line the agent
saw on an earlier screen is not repeated when it scrolls off unchanged; a line
rewritten in place since, such as a progress line or a prompt the agent typed
at, arrives again in its final form. Tools that declare structured output give
`codemode` scripts typed values.

Scrolled-off lines are best effort: they come from termctrl's scrollback, which
is limited (several hundred lines; fewer when lines are long) and drops its
oldest lines first. Reading a Terminal before its scrollback fills loses
nothing. When lines the agent never received were dropped, or the screen was
cleared, the result reports every line termctrl still holds, sets
`output_missing: true`, and says that earlier output is missing. A Terminal's
first result cannot detect dropped lines: when a program prints more than the
scrollback holds before that result, its oldest lines are lost without
`output_missing`, because termctrl does not report the trimming. Run commands
whose complete output matters with `bash`, or redirect their output to a file.

Scrolled-off lines are limited by `termctrl.scrollback` (100 lines or 16 KB by
default). Past it, a result keeps the first and last lines and puts a
`[… N lines omitted …]` line between them. A whole result is limited to Pi's
2000 lines or 50 KB: the screen is kept first, from its bottom, and the
scrolled-off lines fill the rest. With `scrollback` set to `false`, only Pi's
limits apply and the newest scrolled-off lines are kept. When anything is cut,
every line of the result goes to `$TMPDIR/pi-termctrl/<pid>-<id>-output-<n>.log`,
named in the result's notice and `full_output_path`.

`keys` are termctrl key names: `Enter`, `Escape`, `ArrowUp`, `ArrowDown`,
`ArrowLeft`, `ArrowRight`, `Tab`, `Shift+Tab`, `Backspace`, `Delete`, `Home`,
`End`, `PageUp`, `PageDown`, and `Control+A` to `Control+Z`. Text is typed
before keys.

Terminal ids are `t1`, `t2`, … and Background job ids are `b1`, `b2`, …; ids are
never reused in a Pi process, including across `/reload`. At most 16 running
Terminals and Background jobs may exist across the whole process; starting
another fails and lists the caller's live entries.

`terminal_stop` stops a running entry (termctrl stop, then `SIGKILL` of the
Terminal's process group if it is still alive after 3 s) and forgets it. For a
Terminal it returns the final screen and scrolled-off lines; for a Background
job, its recent output. When a Terminal's screen is
unchanged since the agent's last result, the result omits the screen and reports
`changed: false` with `state` and `exit_code` or `signal`; `scrolled_off` still
appears when lines scrolled off since that result. Exited entries stay
readable and listed until the agent stops them, the user removes them in `/ps`,
or their session shuts down. `terminal_list` lists the caller's Terminals and,
in a separate `background_jobs` section, its Background jobs with their log
paths.

`terminal_wait` blocks until one of the caller's Terminals or Background jobs
exits: those listed in `ids`, otherwise every one still running. It returns
every exit by then, in the same form as an Exit notification, plus what is still
running, and those exits send no Exit notification. It also returns when
`wait_ms` runs out, when the call is aborted, or as soon as a message is queued
for the agent, such as the user steering or another entry's Exit notification;
a watched entry that exits after that is notified as usual. With nothing to
wait for it returns at once. Terminal exits are noticed within about 500 ms.

### Tool annotations

Each terminal tool declares MCP-style `annotations`, which Pi reports through `pi.getAllTools()` for permission extensions and does not send to model providers. `terminal_start` and `terminal_send` run arbitrary programs, so they are marked destructive and open-world; neither is idempotent. `terminal_stop` kills processes: destructive and idempotent, closed-world. `terminal_list` and `terminal_wait` are read-only and closed-world. The `bash` replacement keeps the annotations of Pi's built-in `bash`, which declares none.

## `bash` replacement

With `termctrl.replaceBash` (default `true`), Pi Termctrl replaces Pi's `bash`
tool with Pi's own definition plus one parameter, `background?: boolean`.
Commands still run on pipes through Pi's local `exec`, so Pi keeps spawning,
process-tree kills and rendering, and foreground results differ from Pi's only
by the shorter tail below. A command becomes a Background job in two ways:

- **`background: true`** waits 2 s. A command that finishes first returns an
  ordinary result; otherwise the call returns a background result. If the cap
  is reached during those 2 s, the command stays in the foreground.
- **Ctrl+B** while an agent `bash` call runs moves every running call to the
  background. At other times Ctrl+B stays the editor's cursor-left.

Up to 16 MiB of a command's output is kept in memory until it is backgrounded;
older output becomes an omission line in the log. Once backgrounded, a
command's `timeout` is cleared, Esc and turn aborts no
longer reach it, and its output so far and all later output go to
`$TMPDIR/pi-termctrl/<pid>-<id>.log`. The result says
`Command moved to the background as b<n>`, includes the output so far, gives
the log path, and tells the agent not to poll the log but to wait for the Exit
notification or call `terminal_wait`; read the log with `read` and stop the job
with `terminal_stop`. Its structured result follows Pi's `bash` output schema, except
that `exit_code` is absent and `background: { id, log_path }` is present.

**Output tail.** With `termctrl.bashTail` (default `{ lines: 300, bytes: 16384 }`),
the output the model sees from a foreground `bash` call, and the "output so far" of
a backgrounding result, is cut to the last 300 lines or 16 KB, whichever is hit
first, instead of Pi's 2,000 lines or 50 KB. The cut keeps Pi's notice, for example
`[Showing lines 4701-5000 of 5000 (16.0KB or 300 line limit). Full output: /tmp/pi-bash-….log]`,
and names the limits actually used. The named file always holds every line: Pi's own
full-output file when Pi also cut the output, otherwise one Pi Termctrl writes beside
it in `$TMPDIR` (like Pi's, it is not deleted). The tool description names the limits in force. Set `bashTail` to `false`
or `0` to restore Pi's limits. Values above Pi's limits are rejected, and an object with no valid field leaves a lower layer's setting in place.

A Background job's log is deleted when the job is stopped, when the user
removes it in `/ps`, or when its session shuts down for any reason except
reload. `bash` calls from `codemode` scripts behave the same. User `!` commands
are not affected.

**Conflict:** only one extension can own `bash`. Set `"replaceBash": false` when
another extension registers `bash`; Pi's `bash` is then untouched and the
backgrounding paths do not exist.

## Exit notifications

When a Terminal or Background job exits and the agent has neither seen the exit
in a `terminal_*` result nor stopped it, Pi Termctrl sends an Exit notification:
the id, command, exit code or signal, duration, where to find the full output
(a Background job's log path, or `terminal_send` for a Terminal's final screen),
and the last `termctrl.exitTailLines` lines of the final screen or log. Seeing
a Terminal running in a `terminal_*` result does not count as seeing its exit.
Exits reported by `terminal_wait` are not notified again. Exits in the same tick
share one message. While the agent works, notifications wait for the end of its
current turn, then steer it, so an exit a tool call in that turn reported is
not notified. When the agent is idle, a notification starts a turn.
`terminal_start {notify: false}` opts a Terminal out. Notifications go only to
the session that started the entry, and wait across `/reload`.

## `/ps` and footer

`/ps` opens an overlay listing every entry in the Pi process, including those of
in-process child agents, with kind, id, owner (`root` or `child`), state and
age, plus a live preview of the selected Terminal's screen or Background job's
log tail. Keys: `↑`/`↓` select, `k` stops without confirmation (the agent gets an
Exit notification), `x` removes an exited entry, `Esc` closes. The footer shows
`N running` while anything is live. In RPC mode `/ps` sends a one-line summary;
print mode has no UI but keeps the tools and notifications.

## Lifecycle

Terminals and Background jobs live in the Pi process
([ADR-0001](docs/adr/0001-terminals-live-in-the-pi-process.md)). They survive
`/reload`; every other session shutdown (quit, new, resume, fork) stops the
session's own entries. Nothing persists across Pi restarts. Besides Background
job logs and full output files, the only file written is a short-lived pid
handoff file per Terminal launch in `$TMPDIR/pi-termctrl`, deleted as soon as
it is read. Full output files outlive their Terminal, so a `terminal_stop`
result can name one, and are deleted when their session shuts down for any
reason except reload.

## Settings

Pi Termctrl reads the `termctrl` key from Pi's global `settings.json` and
trusted project `.pi/settings.json`; project values override global ones field
by field:

```json
{
  "termctrl": {
    "replaceBash": true,
    "defaultViewport": { "cols": 120, "rows": 40 },
    "exitTailLines": 20,
    "bashTail": { "lines": 300, "bytes": 16384 },
    "scrollback": { "lines": 100, "bytes": 16384 }
  }
}
```

| Setting           | Default                        | Meaning                                                                                                    |
| ----------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `replaceBash`     | `true`                         | Replace `bash` to enable Background jobs                                                                   |
| `defaultViewport` | `{ cols: 120, rows: 40 }`      | Terminal size; each dimension 1 to 1000                                                                    |
| `exitTailLines`   | `20`                           | Lines of output in an Exit notification, 0–1000                                                            |
| `bashTail`        | `{ lines: 300, bytes: 16384 }` | Model-visible `bash` output tail: `lines` 1–2000, `bytes` 1–51200; `false` or `0` restores Pi's limits     |
| `scrollback`      | `{ lines: 100, bytes: 16384 }` | Scrolled-off lines in a Terminal result, keeping the first and last; same ranges and opt-out as `bashTail` |

Invalid values keep the lower layer and unknown keys produce warnings at session
start. Use `/reload` after editing settings.

## Platform

`@kitlangton/terminal-control` installs a `termctrl` binary for macOS and
GNU/Linux on arm64 or x64 through optional dependencies. Set `TERMCTRL_BINARY`
to use another binary. Where no binary resolves (Windows, musl, or
`--omit=optional`), Pi Termctrl shows one diagnostic and registers no
`terminal_start` or `terminal_send`; the `bash` replacement, Background jobs,
`terminal_stop`, `terminal_list` and `terminal_wait` keep working wherever Pi's
`bash` does.

Not supported: attaching to or taking over a Terminal, recordings, mouse input,
resize, raw bytes, persistence across Pi restarts, and graceful `SIGTERM`
stopping of Background jobs.
