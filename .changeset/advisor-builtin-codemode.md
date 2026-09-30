---
"@ian-pascoe/pi-advisor": patch
---

Drop the `@ian-pascoe/pi-codemode` integration in favor of Pi's built-in `codemode`. `advisor_ask` availability now changes only the active tool set, and Advisor Sessions pause only when the advice tool is inactive after extension binding; built-in `codemode.mode: "only"` keeps granted tools active and callable from scripts.
