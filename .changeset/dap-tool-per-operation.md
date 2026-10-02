---
"@ian-pascoe/pi-dap": minor
---

**Breaking:** the single `dap` tool is replaced by one tool per operation: `dap_launch`, `dap_set_breakpoints`, `dap_continue`, `dap_next`, `dap_step_in`, `dap_step_out`, `dap_pause`, `dap_stack`, `dap_variables`, `dap_evaluate`, `dap_status`, and `dap_stop`. Each takes only its own arguments, without `operation`, and all of them still act on the same single Debug Session. There is no `dap` alias: rename `dap` wherever you name tools, such as `--tools`, `defaultTools`, Minimal Subagents toolsets (`dap_*` matches them all), and permission rules. Past `dap` calls in older sessions render with Pi's default tool rendering. Requires Pi 0.99.0 or later, the minimum Pi version this repository's packages support.

All twelve tools are declared to the model and grouped in the `dap` namespace. They carry annotations that permission extensions can use: `dap_stack`, `dap_variables`, and `dap_status` are read-only. Everything that runs the Debuggee's code is destructive and open world: `dap_launch`, `dap_continue`, `dap_next`, `dap_step_in`, `dap_step_out`, and `dap_evaluate`, plus `dap_set_breakpoints`, because a breakpoint `condition` runs as Debuggee code. Pi runs a batch that includes a DAP tool sequentially, in the order the model issued it, and Pi 1.0.0 queues calls that a codemode script starts together the same way.

Codemode scripts now receive structured results with complete data, including all drained Debuggee output and every Stack Frame, variable, Breakpoint, or evaluation value, instead of the text result. A call rejected because of the Debug Session state, such as `dap_stack` after the Debuggee exited, now returns an error result with the current state instead of throwing, so scripts receive that state with an `error` field.
