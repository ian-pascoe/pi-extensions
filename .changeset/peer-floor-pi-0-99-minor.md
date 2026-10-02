---
"@ian-pascoe/pi-advisor": minor
"@ian-pascoe/pi-minimal-subagents": minor
"@ian-pascoe/pi-termctrl": minor
"@ian-pascoe/pi-context-management": minor
"@ian-pascoe/pi-todo": minor
"@ian-pascoe/pi-tps-tracker": minor
"@ian-pascoe/pi-bible-verses": minor
"@ian-pascoe/pi-skills-selector": minor
---

These packages now require Pi `>=0.99.0`, raised from an undeclared (`*`) peer range and a documented floor of `0.84.1` or `0.85.1`. Pi 0.99.0 is the first release that provides the tool exposure, output schema, and built-in extension APIs the repository uses, so the packages no longer carry fallbacks for older hosts.

Advisor no longer probes the Pi SDK for missing exports and methods at load. It no longer pauses with "this Pi runtime lacks ..." diagnostics, because the peer range guarantees those members. Minimal Subagents always gives Child Agents Pi's built-in `codemode`, `tool-search`, and `mcp` extensions instead of skipping any the host lacked. Termctrl's `bash` replacement now requires Pi's `bash` to declare an object `outputSchema`, which Pi provides from 0.99.0, instead of silently falling back to an empty schema.
