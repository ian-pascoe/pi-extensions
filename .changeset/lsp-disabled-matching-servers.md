---
"@ian-pascoe/pi-lsp": patch
---

When every server that handles a file's language is disabled, LSP tools now say so instead of reporting that no configured server matches. The error lists the disabled servers and how to enable one, for example `Pi LSP: all servers matching /repo/src/app.ts are disabled: typescript, eslint; enable one with /lsp enable <id>`. "No configured server matches" remains for files that no enabled server applies to, including one excluded by its required root marker. Disabled servers are still skipped without a warning when another matching server is enabled, and Post-edit Diagnostics stay silent for files whose servers are all disabled.
