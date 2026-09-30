---
"@ian-pascoe/pi-advisor": patch
---

Support Pi 0.99.1. Advisor's version gate now targets 0.99.1. Advisor Sessions recreate the observed session's enabled `builtin:<name>` extensions in their observed order: `codemode`, `tool-search`, and `mcp` from Pi's exported factories, and `llama.cpp` from Pi's shipped extension file. Built-ins disabled with `-builtin:<name>` stay absent, and a host factory registered under a built-in name pauses the Advisor instead of being replaced.
