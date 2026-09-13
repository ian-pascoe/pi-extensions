---
"@ian-pascoe/pi-advisor": minor
"@ian-pascoe/pi-minimal-subagents": minor
"@ian-pascoe/pi-codemode": patch
"@ian-pascoe/pi-mcp": patch
"@ian-pascoe/pi-tps-tracker": patch
---

Add Pi Advisor review sessions, scoped configuration, safe intervention scheduling, and Minimal Subagents integration. Share native AgentSession discovery through `pi-utils`; refactor CodeMode to use the shared capture helper. Resolve discovery against the running host's SDK class, including bundled CLI startup and reload, rather than a compiled dependency's separate SDK instance. Add native Advisor argument autocomplete for commands, settings keys, and scope flags. Recreate Pi 0.85.1's built-in inline llama.cpp extension from its shipped file so actual CLI reviews settle before and after reload, while unsupported inline resources still fail closed. Recognize both verified native auth-storage class names in Pi's bundled CLI and SDK so file-backed OAuth keeps native refresh and locking rather than being misclassified as custom storage.
