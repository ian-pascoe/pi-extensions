# Pi DAP

Pi DAP gives an agent one interactive debugging session through a configured
Debug Adapter Protocol adapter.

## Language

**Debug adapter**:
A process that translates Debug Adapter Protocol requests into operations for a particular runtime.
_Avoid_: Debugger, DAP server

**Debuggee**:
The program being inspected through a debug adapter.
_Avoid_: Target, child process

**Debug session**:
The temporary relationship among Pi, one debug adapter, and one debuggee. It is not a Pi conversation session.
_Avoid_: Connection, run

**Observer UI**:
Human-facing presentation of Debug Session activity in Pi. It does not change the tool result available to the agent or provide direct debugger controls.
_Avoid_: Debugger UI, debug panel

**Observer snapshot**:
The current human-facing summary of a Debug Session, derived only from activity Pi DAP has already observed. It is not authoritative Debug Session state.
_Avoid_: Session state, debugger state

**Adapter definition**:
Named configuration describing how Pi starts or connects to a debug adapter.
_Avoid_: Adapter catalog, debugger configuration

**Launch profile**:
Named configuration describing how a debug adapter starts a debuggee.
_Avoid_: Launch configuration, run profile

**Breakpoint**:
A source location where a running debuggee should stop.
_Avoid_: Checkpoint, stop point

**Desired breakpoint**:
A breakpoint retained by Pi DAP and applied to each new debug session in the same Pi conversation session.
_Avoid_: Saved breakpoint, persistent breakpoint

**Stack frame**:
A suspended function invocation available for inspection and evaluation.
_Avoid_: Frame, call

**Supported adapter**:
A debug adapter whose behavior the package tests and documents.
_Avoid_: Compatible adapter

**Experimental adapter**:
An untested debug adapter that may work through the standard protocol without a compatibility promise.
_Avoid_: Supported adapter
