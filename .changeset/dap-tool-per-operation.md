---
"@ian-pascoe/pi-dap": minor
---

**Breaking:** the single `dap` tool is replaced by one tool per operation: `dap_launch`, `dap_set_breakpoints`, `dap_continue`, `dap_next`, `dap_step_in`, `dap_step_out`, `dap_pause`, `dap_stack`, `dap_variables`, `dap_evaluate`, `dap_status`, and `dap_stop`. Each takes only its own arguments, without `operation`, and all of them still act on the same single Debug Session. There is no `dap` alias: rename `dap` wherever you name tools, such as `--tools`, `defaultTools`, Minimal Subagents toolsets (`dap_*` matches them all), and permission rules. Past `dap` calls in older sessions render with Pi's default tool rendering. Requires Pi 0.99.0 or later.

`dap_pause` is not declared to the model by default, because it is needed only after an execution wait times out. Pi's codemode scripts can call it and list it with its type, and `tool_search` can load it; neither is on by default. Otherwise add `"+dap_pause"` to `defaultTools`. `dap_stop` remains declared for a runaway Debuggee. The other tools are declared as before.

The tools share the `dap` namespace and carry annotations that permission extensions can use: `dap_stack`, `dap_variables`, and `dap_status` are read-only, while `dap_launch` and `dap_evaluate` run arbitrary code. Calls now run sequentially, in the order the model issued them.

Codemode scripts now receive structured results with complete data, including all drained Debuggee output and every Stack Frame, variable, Breakpoint, or evaluation value, instead of the text result. A call rejected because of the Debug Session state, such as `dap_stack` after the Debuggee exited, now returns an error result with the current state instead of throwing, so scripts receive that state with an `error` field.
