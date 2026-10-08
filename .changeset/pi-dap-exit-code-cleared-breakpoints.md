---
"@ian-pascoe/pi-dap": patch
---

Report the Debuggee `exit_code` for a Node Debug Session through `vscode-js-debug` (which sends no `exited` event): from its root-channel exit report for the default console, or from the process Pi runs for a terminal `console`, and leave it unknown when the adapter does not report one. Also drop a file from `desired_breakpoints` when its breakpoints are set to `[]`.
