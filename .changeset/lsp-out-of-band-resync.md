---
"@ian-pascoe/pi-lsp": patch
---

Diagnostics for a file now account for other open files changed outside Pi, such as by a shell command, codegen, or a checkout: Pi sends their new text to the server first, and a file whose findings the server does not republish keeps its last ones. Post-edit Diagnostics now include push-only servers such as typescript-language-server; a push-only server that has never published diagnostics drops out after its first silent wait, and a push-only server's silence counts a file as clean rather than timed out.
