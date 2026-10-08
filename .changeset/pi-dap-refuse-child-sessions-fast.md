---
"@ian-pascoe/pi-dap": minor
---

Stop a `vscode-js-debug` Debuggee that starts a worker thread or child process (such as a test runner's forks) from hanging `dap_launch` until the execution timeout. Pi DAP still refuses the child session, but now lets the child run without a debugger and names it in the next `dap_launch`, `dap_continue`, stepping, `dap_pause`, or `dap_status` result (`rejected_child_sessions`), saying that child debugging is unsupported and breakpoints in it will not bind. `dap_launch` also takes `launch_arguments`, adapter launch arguments merged over the Launch Profile's for one launch, for example `autoAttachChildProcesses: false`.
