---
"@ian-pascoe/pi-utils": minor
---

Add `@ian-pascoe/pi-utils/token-calibration`: `tokenFactor`, `calibratedFactor`, `fallbackTokenFactor`, and the `TokenSample` type, moved from Guardian. They learn a per-model multiple of Pi's chars/4 token estimate from the tokens a provider reports. `tokenFactor` also takes the caller's own fallback factor.
