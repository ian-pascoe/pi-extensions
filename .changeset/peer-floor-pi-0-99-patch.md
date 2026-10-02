---
"@ian-pascoe/pi-command-deck": patch
"@ian-pascoe/pi-dap": patch
"@ian-pascoe/pi-formatter": patch
"@ian-pascoe/pi-git-checkpoints": patch
"@ian-pascoe/pi-lsp": patch
"@ian-pascoe/pi-utils": patch
"@ian-pascoe/pi-web-tools": patch
---

Declare Pi `>=0.99.0` as the peer range for `@earendil-works/pi-coding-agent`, `pi-ai`, `pi-agent-core`, and `pi-tui`, replacing `*`. Installing against an older Pi now warns at install time instead of failing when a package uses an API that Pi release lacks. Pi Utils keeps its Pi peer optional.
