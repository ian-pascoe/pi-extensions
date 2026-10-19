---
"@ian-pascoe/pi-lsp": minor
---

Cap how many diagnostics requests each Server Instance has in flight with the new optional per-Server-Definition `maxConcurrentDiagnostics` setting (positive integer, default 2). Document-pull and workspace-pull requests from Post-edit Diagnostics, the Pre-edit Baseline, dependent-file scans, `lsp_diagnostics`, and workspace diagnostics wait in a first-in, first-out queue per Server Instance, so a server that is costly per request (oxlint with `typeAware`) no longer saturates the machine and a slow server never delays another. The `diagnosticsMs` timeout starts when a request is sent, and aborting a call drops its queued requests unsent. An invalid value warns and falls back to the default. The diagnostics reported do not change.
