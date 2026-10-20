---
"@ian-pascoe/pi-utils": minor
---

Let the secret registry hold Secrets whose values live elsewhere: `holdRefreshableSecret(name, owner, { refresh, value?, expiresAt? })` registers a refresh callback, `refreshSecret(name)` reads the current value through it and keeps every value read redacted, and `isSecretHeld(name)` reports a held Secret before its first read. `redactionGeneration()` counts the values held so far, and `redactSecrets(value, generation)` redacts only the values held by that generation, so text redacted once can be redacted the same way later.
