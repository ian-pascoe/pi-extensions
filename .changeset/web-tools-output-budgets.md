---
"@ian-pascoe/pi-web-tools": minor
---

`web_search` now cuts Search Provider text at 6,000 characters when `contextMaxCharacters` is omitted (an explicit value up to 50,000 still overrides it), and `web_fetch` accepts line-based `offset` and `limit`, like Pi's `read` tool, and reports how many lines remain and the `offset` to continue from.
