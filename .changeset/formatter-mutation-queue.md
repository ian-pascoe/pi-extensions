---
"@ian-pascoe/pi-formatter": patch
---

Format inside Pi's file mutation queue. With parallel `edit`s to one file, the `Formatted by` diff now shows only the formatter's changes instead of another edit's, and an edit that arrives while a formatter runs waits for it instead of being overwritten.
