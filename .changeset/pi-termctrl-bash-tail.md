---
"@ian-pascoe/pi-termctrl": minor
---

Foreground `bash` results and the "output so far" of backgrounding results now keep the last 300 lines or 16 KB instead of Pi's 2,000 lines or 50 KB. The notice names the limits used and the file holding every line. Set `termctrl.bashTail` to change the limits, or to `false` or `0` to restore Pi's.
