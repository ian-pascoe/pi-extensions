---
"@ian-pascoe/pi-utils": minor
"@ian-pascoe/pi-minimal-subagents": patch
---

Support Pi 1.5. `@ian-pascoe/pi-utils/string-enum` adds `StringEnum`, a TypeBox string enum schema that keeps tool parameters typed now that the published `@earendil-works/pi-ai` returns a pi-schema `Schema<T>`; the declared JSON Schema is unchanged. `@ian-pascoe/pi-utils/ui-testing` adds `keybindingHints`, a stand-in for the `keyText`/`keyHint` Pi 1.5 injects into renderer options. Pi Minimal Subagents validates toolset patterns with minimatch 11, which removed `makeRe()`.
