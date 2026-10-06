---
"@ian-pascoe/pi-termctrl": patch
---

`terminal_stop` no longer hangs on an exited Terminal while termctrl shuts down its idle driver, as right after the last running Terminal exits.
