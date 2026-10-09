---
"@ian-pascoe/pi-dap": minor
---

Debug vscode-js-debug child sessions (worker threads and child processes, such as vitest's `forks` and `threads` pool workers) inside the one Debug Session instead of refusing them. Breakpoints now bind in children. A stop in a child names it in `child_session`, and only one stop is reported at a time: inspection and stepping act on the target that stopped, and a stop that was waiting is reported as soon as that target resumes. `dap_pause` pauses every target. Thread ids are assigned by Pi DAP for vscode-js-debug. `debugger;` statements and exceptions in children now stop instead of being continued automatically. `rejected_child_sessions` now lists only child sessions Pi DAP could not debug.
