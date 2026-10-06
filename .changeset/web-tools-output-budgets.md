---
"@ian-pascoe/pi-web-tools": minor
---

`web_search` now cuts Search Provider text at 6,000 characters when `contextMaxCharacters` is omitted (an explicit value up to 50,000 still overrides it), and `web_fetch` accepts line-based `offset` and `limit`, like Pi's `read` tool, and ends a result that stops early with a continuation note naming the `offset` to continue from. Breaking for `codemode` scripts: `web_search` `structuredContent.content` is now capped at 6,000 characters by default, and `web_fetch` `content` and `full_output_path` hold only the requested `offset`/`limit` window; scripts also get `total_lines` and `next_offset` when they pass a window.
