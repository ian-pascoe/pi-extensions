---
"@ian-pascoe/pi-dap": patch
---

Report the Debuggee `exit_code` for a Node Debug Session through `vscode-js-debug` (which sends no `exited` event) by waiting for its root-channel exit report, and drop a file from `desired_breakpoints` when its breakpoints are set to `[]`.
