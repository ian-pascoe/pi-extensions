---
"@ian-pascoe/pi-termctrl": patch
---

Queue `terminal_send` calls (and the final snapshot of `terminal_stop`) per Terminal, so a parallel batch of sends to one Terminal types, settles, and returns screens in call order instead of interleaving. Calls to different Terminals stay concurrent; aborting a queued call removes it without affecting the running one.
