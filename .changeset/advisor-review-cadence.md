---
"@ian-pascoe/pi-advisor": minor
---

Advisor Reviews can now cost less. The new `reviewEvery` setting reviews after every turn (`"turn"`, the default), after every N turns and when the request completes, or once per request (`"request"`); a turn with a failed tool call is still reviewed at once, and each Review covers every turn not yet reviewed. The new `maxSessionTokens` setting (default `auto`, half the Advisor model's context window) compacts the private Advisor Session with Pi's native compaction after a Review that leaves it larger, so later Reviews stop re-reading an ever-growing history; delivered findings, deferred Concerns, and incremental evidence carry on unchanged. `/advisor status` now shows the last Review's cost and the running total of Reviews, including any compaction they ran, and shows unknown cost as unknown.
