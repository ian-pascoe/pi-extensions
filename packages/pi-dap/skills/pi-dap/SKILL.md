---
name: pi-dap
description: Configure or diagnose Pi DAP when an Adapter Definition or Launch Profile fails, a Debug Session is stuck, or breakpoints do not bind.
license: MIT
disable-model-invocation: true
---

# Pi DAP

1. Read [`../../README.md`](../../README.md)'s Settings section and identify the effective Adapter Definition and Launch Profile.
2. Call `dap_status`, then inspect settings warnings and retained adapter stderr.
3. Verify the configured command and referenced files without launching.
4. Classify the failure as settings, adapter startup, protocol, state, timeout, or source mapping.
5. For a requested change, edit one settings layer, validate JSON, and reload Pi.
6. With approval, run one representative launch. Finish when it reaches the expected Debug Session state or one exact adapter or protocol failure remains.

For `vscode-js-debug`, a stop with reason `entry` that repeats inside the program's first function, with no `hit breakpoint ids`, means the profile sets `stopOnEntry` and js-debug's entry breakpoint moved into that function. Remove `stopOnEntry` from the Launch Profile; your own breakpoint stops list `hit breakpoint ids`; an entry stop lists none.

For `vscode-js-debug`, a result that lists a refused child session (`rejected_child_sessions`) means the Debuggee started a worker thread or child process; breakpoints in it never bind. Debug the child's own file as the `program`, or pass `launch_arguments: { autoAttachChildProcesses: false }` to `dap_launch` to skip attaching child processes.

Ask before starting, pausing, stopping, or otherwise changing a Debuggee. An execution timeout may leave it running, so inspect `dap_status` first.
