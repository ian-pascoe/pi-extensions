---
"@ian-pascoe/pi-minimal-subagents": patch
---

Let Child Agents use llama.cpp models under Pi's standalone binary. That binary bundles the built-in `llama.cpp` extension and ships no file for it, so a llama.cpp launch model was reported as a missing dependency. Children now register a non-refreshing view of the root's `llama.cpp` provider instead: they share the root's model catalog live without refreshing it, and have no `/llama`. Installs from npm still load the extension from Pi's shipped file.
