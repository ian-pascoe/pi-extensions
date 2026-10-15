---
"@ian-pascoe/pi-command-deck": patch
---

Support pi-tui 1.2's fake-cursor markers. With pi-tui 1.2 the empty-prompt placeholder disappeared, the Vim editor kept the software cursor next to the hardware cursor, and the cursor could cut a Visual highlight short. pi-tui 1.1's reverse-video cursor still works.
