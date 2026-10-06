---
"@ian-pascoe/pi-dap": patch
---

`dap_set_breakpoints` now keeps the Desired Breakpoints but warns, in the result text and in `structuredContent.warnings`, when the source file does not exist or is not a file.
