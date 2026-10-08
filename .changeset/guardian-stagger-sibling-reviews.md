---
"@ian-pascoe/pi-guardian": patch
---

Stagger the early reviews of a parallel tool batch: the first review starts at once and its siblings start when its request begins streaming (or when it settles, if it fails), so siblings read the prompt-cache entry the first one wrote instead of racing it.
