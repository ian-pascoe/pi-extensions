---
"@ian-pascoe/pi-termctrl": minor
---

Terminals now send an Exit notification when they exit after the agent saw them running. Before, the first `terminal_start` or `terminal_send` result marked a running Terminal as seen, so its later exit was never reported. Background jobs were not affected.

The new `terminal_wait` tool blocks until a Terminal or Background job exits. It returns each exit, in the same form as an Exit notification, along with what is still running, and those exits are not notified again. It returns early when `wait_ms` runs out, when the call is aborted, or when a message is queued. While the agent works, Exit notifications now wait for the end of its current turn, so an exit that a tool call in that turn reports, such as through `terminal_wait`, is not notified as well. Exit notifications now point to the full output: a Background job's log path, or `terminal_send` for a Terminal's final screen. A backgrounded `bash` result now tells the agent not to poll the log, and to wait for the Exit notification or call `terminal_wait` instead.
