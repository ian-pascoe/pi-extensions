---
"@ian-pascoe/pi-advisor": minor
---

Under the default `reviewEvery: "turn"` cadence, a turn whose tool calls are all read-only (Pi's `read`, `grep`, `find`, and `ls`, or tools annotated `readOnlyHint: true`) now joins the Review Backlog without starting a Review. The next other turn, an errored tool result, or request completion reviews the backlog, so Reviews no longer re-read the Advisor Session for pure exploration. `bash` never counts as read-only. The trade-off is that findings about exploration arrive with the next Review.
