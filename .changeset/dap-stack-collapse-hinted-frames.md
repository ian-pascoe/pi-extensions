---
"@ian-pascoe/pi-dap": minor
---

`dap_stack` text now collapses each run of two or more Stack Frames that the adapter hints as noise (frame `presentationHint` `subtle` or `label`, or source `presentationHint` `deemphasize`) into one line such as `… 13 deemphasized frames (ids 34–46)`. The ids still work with `dap_variables` and `dap_evaluate`, and `stack_frames` and `total_frames` in `structuredContent` are unchanged.
