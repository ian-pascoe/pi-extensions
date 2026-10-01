---
"@ian-pascoe/pi-advisor": patch
"@ian-pascoe/pi-bible-verses": patch
"@ian-pascoe/pi-context-management": patch
"@ian-pascoe/pi-dap": patch
"@ian-pascoe/pi-formatter": patch
"@ian-pascoe/pi-git-checkpoints": patch
"@ian-pascoe/pi-git-status-widget": patch
"@ian-pascoe/pi-lsp": patch
"@ian-pascoe/pi-minimal-subagents": patch
"@ian-pascoe/pi-skills-selector": patch
"@ian-pascoe/pi-termctrl": patch
"@ian-pascoe/pi-todo": patch
"@ian-pascoe/pi-tps-tracker": patch
"@ian-pascoe/pi-web-tools": patch
---

Bundled troubleshooting Skills no longer appear in the model's system prompt. Each now sets `disable-model-invocation: true`, so installing the package adds no per-turn context and you no longer need `skills` package filters to hide them. To open one, use `/skill:<package>` or a `$<package>` Skill Reference. Packages whose failures the model can see append that package's Skill path to configuration and runtime failures, so the model loads the guide only when one occurs.
