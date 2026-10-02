# @ian-pascoe/pi-termctrl

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
