---
"@ian-pascoe/pi-dap": minor
---

Desired Breakpoints now appear only in `dap_set_breakpoints`, `dap_launch`, and `dap_status` results, in their text, structured results, and output schemas. Other DAP tools no longer return `desired_breakpoints`, and their descriptions name the `error` message of a state failure.
