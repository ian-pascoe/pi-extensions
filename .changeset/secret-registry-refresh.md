---
"@ian-pascoe/pi-utils": minor
---

Let the secret registry hold Secrets whose values live elsewhere: `holdRefreshableSecret(name, owner, { refresh, value?, expiresAt? })` registers a refresh callback, `refreshSecret(name)` reads the current value through it and keeps every value read redacted, and `isSecretHeld(name)` reports a held Secret before its first read.
