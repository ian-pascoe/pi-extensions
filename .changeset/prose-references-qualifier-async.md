---
"@ian-pascoe/pi-utils": minor
---

`@ian-pascoe/pi-utils/prose-references` gains what an issue selector needs: `replaceProseReferences` takes an optional `qualifier` (such as `owner/repo` before `#12`, passed to `resolve`) and `excludeBefore` characters, `findProseReferencePrefix` and `stackProseReferenceAutocomplete` take `excludeBefore`, and `suggest` may be asynchronous and receives the request's `AbortSignal`. Existing callers are unaffected.
