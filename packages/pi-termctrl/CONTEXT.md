# Pi Termctrl

Pi Termctrl gives the agent interactive terminals and lets slow shell commands
continue in the background, with a human-facing list of everything still running.

## Language

**Terminal**:
A PTY-backed program that Pi Termctrl starts through termctrl, which the agent drives by sending input and reading the screen. It is not a Pi conversation session.
_Avoid_: Session, shell, process

**Background job**:
A `bash` tool command the user moved to the background while it ran. It keeps its original pipes and accepts no input.
_Avoid_: Background shell, detached process, task

**Bash tail**:
The last lines and bytes of a `bash` result that the model sees, set by `termctrl.bashTail`: the foreground output and the "output so far" of a backgrounding result. The full output stays in a log file the result names.
_Avoid_: Output limit, truncation

**Scrolled-off lines**:
The lines that left a Terminal's screen since the agent's previous result, reported with that result. A line the agent already saw on a screen is not reported again unless it changed. The `termctrl.scrollback` setting limits how many a result shows, keeping the first and last; termctrl's own scrollback, the limited log they are read from, is a different thing.
_Avoid_: Output, history

**Screen Delta**:
The screen rows from the previous result's cursor row down, sent instead of the whole screen when the rows above are unchanged.
_Avoid_: Diff, patch

**Exit notification**:
A message telling the agent that a Terminal or Background job ended, which it had not already seen through a tool call.
_Avoid_: Completion event, callback

**Call queue**:
The order in which the agent's `terminal_start`, `terminal_send` and `terminal_stop` calls to one Terminal run: each types, presses keys, and settles (or stops the Terminal) before the next starts. Each Terminal has its own queue; `terminal_list` and `terminal_wait` do not use it.
_Avoid_: Lock, serialization
