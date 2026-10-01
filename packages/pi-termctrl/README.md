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

`terminal_start` runs `command` through the shell Pi's `bash` uses (the
`shellPath` setting, otherwise Pi's default bash), applies `shellCommandPrefix`,
and opens a PTY sized by `termctrl.defaultViewport`.

`terminal_start` and `terminal_send` wait until the Terminal **settles**: at the
first of 250 ms of screen quiet, a `wait_for_text` match, process exit, or
`wait_ms` running out. `wait_for_text` is a literal substring, or a regex when
written as `/source/flags`; with `wait_for_text`, quiet alone does not end the
wait, and text already on the screen before `terminal_send` counts only after
the screen changes. Default waits are 2 s for `terminal_start`, 500 ms for `terminal_send`
with input, and 30 s for a `terminal_send` with neither `text` nor `keys` (a
poll, which settles on quiet only after new output). Every `wait_ms` clamps to
5 minutes.

Results contain the visible screen, the log lines that scrolled off since the
agent's previous result, `state`, `exit_code` or `signal` once exited, and
`changed: false` when the screen matches the previous result. Scrolled-off lines
include lines the agent saw on an earlier screen, so a line rewritten in place,
such as a progress line, arrives in its final form. Tools that declare
structured output give `codemode` scripts typed values.

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

A result is limited to Pi's 2000 lines or 50 KB. The screen is kept first, from
its bottom, and the newest scrolled-off lines fill the rest. When anything is
cut, every line of the result goes to
`$TMPDIR/pi-termctrl/<pid>-<id>-output-<n>.log`, named in the result's notice
and `full_output_path`.

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
job, its recent output. Exited entries stay
readable and listed until the agent stops them, the user removes them in `/ps`,
or their session shuts down. `terminal_list` lists the caller's Terminals and,
in a separate `background_jobs` section, its Background jobs with their log
paths.

## `bash` replacement

With `termctrl.replaceBash` (default `true`), Pi Termctrl replaces Pi's `bash`
tool with Pi's own definition plus one parameter, `background?: boolean`.
Commands still run on pipes through Pi's local `exec`, so Pi keeps spawning,
process-tree kills, truncation and rendering, and foreground results are
unchanged. A command becomes a Background job in two ways:

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
`Command moved to the background as b<n>`, includes the output so far, and
gives the log path; read the log with `read` and stop the job with
`terminal_stop`. Its structured result follows Pi's `bash` output schema, except
that `exit_code` is absent and `background: { id, log_path }` is present.

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
the id, command, exit code or signal, duration, and the last
`termctrl.exitTailLines` lines of the final screen or log. Exits in the same tick
share one message. It steers a working agent and starts a turn when the agent is
idle. `terminal_start {notify: false}` opts a Terminal out. Notifications go
only to the session that started the entry, and wait across `/reload`.

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
    "exitTailLines": 20
  }
}
```

| Setting           | Default                   | Meaning                                         |
| ----------------- | ------------------------- | ----------------------------------------------- |
| `replaceBash`     | `true`                    | Replace `bash` to enable Background jobs        |
| `defaultViewport` | `{ cols: 120, rows: 40 }` | Terminal size; each dimension 1 to 1000         |
| `exitTailLines`   | `20`                      | Lines of output in an Exit notification, 0–1000 |

Invalid values keep the lower layer and unknown keys produce warnings at session
start. Use `/reload` after editing settings.

## Platform

`@kitlangton/terminal-control` installs a `termctrl` binary for macOS and
GNU/Linux on arm64 or x64 through optional dependencies. Set `TERMCTRL_BINARY`
to use another binary. Where no binary resolves (Windows, musl, or
`--omit=optional`), Pi Termctrl shows one diagnostic and registers no
`terminal_start` or `terminal_send`; the `bash` replacement, Background jobs,
`terminal_stop` and `terminal_list` keep working wherever Pi's `bash` does.

Not supported: attaching to or taking over a Terminal, recordings, mouse input,
resize, raw bytes, persistence across Pi restarts, and graceful `SIGTERM`
stopping of Background jobs.
