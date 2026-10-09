---
"@ian-pascoe/pi-lsp": minor
---

Post-edit Diagnostics for a native `edit` or `write` now compare the changed file with its Pre-edit Baseline: only findings the edit introduced are listed, existing ones are counted per severity (`src/a.ts: 2 new; unchanged: 1 error, 12 warnings`), and a server whose baseline pull failed lists every finding with a note. Post-edit lines show the rule code as `source(code)`, and post-edit, `lsp_diagnostics`, and `lsp_workspace_diagnostics` lines show a range end (`5:28-52`, `5:28-6:3`) when it differs from the start.
