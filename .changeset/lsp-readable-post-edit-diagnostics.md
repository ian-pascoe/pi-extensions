---
"@ian-pascoe/pi-lsp": minor
---

Post-edit Diagnostics read as compact text. Findings are one `path:line:col severity [server]: message` line each, with paths relative to the working directory, named severities (`error`, `warning`, `info`, `hint`) instead of `severity 1`, and the full message collapsed onto one line. When every changed file is clean, the section is the single line `LSP diagnostics: no diagnostics`; otherwise clean files share one `no diagnostics: a.ts, b.ts` line. Files with no configured server share one `not checked (no configured server): README.md, package.json` line. That now includes a file whose language a server handles but whose required root marker is missing; before, such a file produced no output, which looked the same as a clean result. A file whose matching servers you disabled stays silent.
