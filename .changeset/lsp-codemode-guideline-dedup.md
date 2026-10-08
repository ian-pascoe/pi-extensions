---
"@ian-pascoe/pi-lsp": patch
---

Stop repeating the shared guideline on every script-callable LSP tool and shorten their result declarations, so Pi's `codemode` description lists the call-hierarchy, implementation, type-definition, and signature-help tools within the default inline budget. The directly declared tool definitions are unchanged.

The shared rules now head the `## lsp` section of the `codemode` description, so they stay visible once with `codemode.mode: "only"`.

With `codemode.mode: "only"`, the direct tools (such as `lsp_diagnostics` and `lsp_rename`) now fall out of the `codemode` listing because each carries the shared guideline; they stay findable with `searchTools()`.
