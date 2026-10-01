---
"@ian-pascoe/pi-minimal-subagents": minor
---

Load Pi's built-in llama.cpp extension in Child Agents, honoring `-builtin:llama.cpp`, so children can use llama.cpp models; when Pi's llama.cpp file is unavailable, a llama.cpp launch model is reported as a missing dependency. A reopened child now re-declares the tools it last declared, including tools loaded through `tool_search`, keeping its prompt cache stable. Child `codemode` scripts no longer get a `models` API that could call models outside the Launch Contract.
