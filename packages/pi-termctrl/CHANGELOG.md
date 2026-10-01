# @ian-pascoe/pi-termctrl

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
