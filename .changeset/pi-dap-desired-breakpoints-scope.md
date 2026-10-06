---
"@ian-pascoe/pi-dap": minor
---

**Breaking:** Desired Breakpoints now appear only in `dap_set_breakpoints`, `dap_launch`, and `dap_status` results, in their text, structured results, and output schemas. Other DAP tools no longer return `desired_breakpoints`; read it from `dap_status` instead. Descriptions of tools that can fail on the Debug Session state now name the `error` message.
