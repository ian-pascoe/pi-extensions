---
"@ian-pascoe/pi-dap": minor
---

DAP tool results are now compact multi-line text instead of a raw JSON dump, and a stop result names the top frame's file, line, and function plus the stop description and hit Breakpoint ids, so no separate `dap_stack` call is needed. Desired Breakpoints appear in text only after `dap_set_breakpoints`; `structuredContent` keeps its fields and gains `stop_description`, `hit_breakpoint_ids`, and `top_frame`.
