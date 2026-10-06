---
"@ian-pascoe/pi-dap": patch
---

`dap_variables` with `frame_id` now lists expensive scopes such as js-debug's Global without expanding them, so locals stay visible without reading a Result Spill, and over-limit text is always cut at line boundaries so the visible part is never empty.
