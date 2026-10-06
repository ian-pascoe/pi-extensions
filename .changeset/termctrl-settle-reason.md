---
"@ian-pascoe/pi-termctrl": minor
---

`terminal_start` and `terminal_send` results now say why the wait ended. The Structured Result has a `settle_reason` of `matched` (`wait_for_text` found), `timeout` (`wait_ms` ran out), `quiet` (250 ms of screen quiet) or `exited` (the Terminal exited), and the result text repeats it in its first line, such as `t1 running · settled: timeout`. A `wait_for_text` that times out is no longer indistinguishable from a match: the text adds that the pattern was not seen. Polls, which send neither `text` nor `keys`, report their reason too.
