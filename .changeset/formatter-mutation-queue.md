---
"@ian-pascoe/pi-formatter": patch
---

Format inside Pi's file mutation queue. With parallel `edit`s to one file, the `Formatted by` diff now shows only the formatter's changes instead of another edit's, an edit that arrives while a formatter runs waits for it instead of being overwritten, and a file deleted or renamed by a mutation queued ahead of formatting is skipped. A formatter that times out or is aborted is now killed with `SIGKILL`, and formatting waits, for at most two seconds, until any process it started stops writing.
