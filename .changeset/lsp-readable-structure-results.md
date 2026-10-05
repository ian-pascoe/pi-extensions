---
"@ian-pascoe/pi-lsp": minor
---

Symbol, hierarchy, and range results read as compact text. Document and workspace symbols show the model an indented outline of `name (kind) path:line:col` lines with named symbol kinds (`class`, `function`, `variable`, …) instead of numbers; call and type hierarchies list `name (kind) path:line:col` items with incoming and outgoing call sites as `path:line:col  <source line>`; selection ranges are a flat innermost-to-outermost list; and folding ranges read `startLine-endLine kind  <first source line>`. Paths are relative to the working directory. Structured Results for codemode scripts are unchanged.

Outgoing call sites are now converted against the file of the prepared call-hierarchy item rather than the queried file, so `lsp_outgoing_calls` at a call site whose declaration lives in another file no longer fails or reports wrong columns.
