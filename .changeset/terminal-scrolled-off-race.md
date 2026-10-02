---
"@ian-pascoe/pi-termctrl": patch
---

A Terminal result no longer reports lines its own screen still shows as scrolled off. termctrl's screen and log are read in two requests, and output that arrived between them made the result count the screen's top lines as scrolled off, so the next result skipped the line the agent had just seen at the top of the screen. Before a Terminal's screen filled, lines that had never scrolled off could be reported as scrolled off, and a line rewritten after that was never reported in its final form. The result now finds its screen in the log and leaves every line on it unread.
