# @ian-pascoe/pi-termctrl

## 0.6.0

### Minor Changes

- a7769c1: Terminal results no longer repeat lines the agent already saw. A line from an earlier result's screen is skipped when it scrolls off unchanged; a line rewritten since, such as a progress line or a prompt the agent typed at, still arrives in its final form. Scrolled-off lines in `terminal_start`, `terminal_send` and `terminal_stop` results are now limited by the new `termctrl.scrollback` setting (default 100 lines or 16 KB): past it, the result keeps the first and last lines with a `[… N lines omitted …]` line between them, and `full_output_path` names a file holding every line. Set `scrollback` to `false` or `0` to keep only Pi's 2000-line or 50 KB limit on the whole result. `output_missing` is unchanged.

## 0.5.0

### Minor Changes

- 447c32c: Foreground `bash` results and the "output so far" of backgrounding results now keep the last 300 lines or 16 KB instead of Pi's 2,000 lines or 50 KB. The notice names the limits used and the file holding every line. Set `termctrl.bashTail` to change the limits, or to `false` or `0` to restore Pi's.

### Patch Changes

- fcfe100: Queue `terminal_send` calls (and `terminal_stop`) per Terminal, so a parallel batch of sends to one Terminal types, settles, and returns screens in call order instead of interleaving. Calls to different Terminals stay concurrent; aborting a queued call removes it without affecting the running one.

## 0.4.1

### Patch Changes

- cc9bd12: `terminal_stop` no longer hangs on an exited Terminal while termctrl shuts down its idle driver, as right after the last running Terminal exits.
- 1a9b525: `terminal_stop` now omits an unchanged final screen for running Terminals too, matching its description.

## 0.4.0

### Minor Changes

- 7ae7fed: `terminal_start` and `terminal_send` results now say why the wait ended. The Structured Result has a `settle_reason` of `matched` (`wait_for_text` found), `timeout` (`wait_ms` ran out), `quiet` (250 ms of screen quiet) or `exited` (the Terminal exited), and the result text repeats it in its first line, such as `t1 running · settled: timeout`. A `wait_for_text` that times out is no longer indistinguishable from a match: the text adds that the pattern was not seen. Polls, which send neither `text` nor `keys`, report their reason too.

### Patch Changes

- f6b9802: Terminal edge cases now fail loudly and cheaply. `terminal_send` with `text` or `keys` to an exited Terminal returns an error naming its exit code or signal instead of silently dropping the input; a poll still returns the final screen. `terminal_stop` on an exited Terminal whose screen is unchanged since the agent's last result omits the screen and returns only its state and exit code or signal. `terminal_start` with a `cwd` that is missing or not a directory fails with an error naming the resolved path instead of termctrl's opaque "canonicalize session working directory" message.

## 0.3.0

### Minor Changes

- 0ea1e75: These packages now require Pi `>=0.99.0`, raised from an undeclared (`*`) peer range and a documented floor of `0.84.1` or `0.85.1`. Pi 0.99.0 is the first release that provides the tool exposure, output schema, and built-in extension APIs the repository uses, so the packages no longer carry fallbacks for older hosts.

  Advisor no longer probes the Pi SDK for missing exports and methods at load. It no longer pauses with "this Pi runtime lacks ..." diagnostics, because the peer range guarantees those members. Minimal Subagents always gives Child Agents Pi's built-in `codemode`, `tool-search`, and `mcp` extensions instead of skipping any the host lacked. Termctrl's `bash` replacement now requires Pi's `bash` to declare an object `outputSchema`, which Pi provides from 0.99.0, instead of silently falling back to an empty schema.

- bf36a67: The Terminal tools now declare MCP-style tool `annotations`, reported through `pi.getAllTools()` for permission extensions. `terminal_start` and `terminal_send` run arbitrary programs, so they are destructive and open-world and not idempotent. `terminal_stop` is destructive and idempotent. `terminal_list` and `terminal_wait` are read-only and closed-world. The `bash` replacement keeps the annotations of Pi's built-in `bash`, which declares none. Annotations are not sent to model providers, so tool declarations, the system prompt, and the prompt cache prefix are unchanged, with and without built-in `codemode`.

### Patch Changes

- af2f405: A Terminal result no longer reports lines its own screen still shows as scrolled off. termctrl's screen and log are read in two requests, and output that arrived between them made the result count the screen's top lines as scrolled off, so the next result skipped the line the agent had just seen at the top of the screen. Before a Terminal's screen filled, lines that had never scrolled off could be reported as scrolled off, and a line rewritten after that was never reported in its final form. The result now finds its screen in the log and leaves every line on it unread.

## 0.2.0

### Minor Changes

- 31cdbc9: Terminals now send an Exit notification when they exit after the agent saw them running. Before, the first `terminal_start` or `terminal_send` result marked a running Terminal as seen, so its later exit was never reported. Background jobs were not affected.

  The new `terminal_wait` tool blocks until a Terminal or Background job exits. It returns each exit, in the same form as an Exit notification, along with what is still running, and those exits are not notified again. It returns early when `wait_ms` runs out, when the call is aborted, or when a message is queued. While the agent works, Exit notifications now wait for the end of its current turn, so an exit that a tool call in that turn reports, such as through `terminal_wait`, is not notified as well. Exit notifications now point to the full output: a Background job's log path, or `terminal_send` for a Terminal's final screen. A backgrounded `bash` result now tells the agent not to poll the log, and to wait for the Exit notification or call `terminal_wait` instead.

## 0.1.1

### Patch Changes

- 2daa891: Bundled troubleshooting Skills no longer appear in the model's system prompt. Each now sets `disable-model-invocation: true`, so installing the package adds no per-turn context and you no longer need `skills` package filters to hide them. To open one, use `/skill:<package>` or a `$<package>` Skill Reference. Packages whose failures the model can see append that package's Skill path to configuration and runtime failures, so the model loads the guide only when one occurs.

## 0.1.0

### Minor Changes

- cf5ebd5: Add Pi Termctrl: interactive Terminals driven through termctrl (`terminal_start`, `terminal_send`, `terminal_stop`, `terminal_list`), a `bash` replacement whose commands move to the background with `background: true` or Ctrl+B, Exit notifications, and a `/ps` panel with a footer count.
