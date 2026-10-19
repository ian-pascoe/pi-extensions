---
"@ian-pascoe/pi-utils": minor
---

Add `@ian-pascoe/pi-utils/secret-registry`, a process-wide registry of held Secrets shared by every pi-utils copy. Packages use it to resolve Secret References and to redact Secret values, as written or in common encodings such as hex and base64, without depending on Pi Secret.
