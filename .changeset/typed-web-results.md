---
"@ian-pascoe/pi-web-tools": minor
---

`web_search` and `web_fetch` now declare an `outputSchema` and return `structuredContent`, so a Pi `codemode` script receives an object instead of text. `web_search` returns `{ provider, content, fullOutputPath? }`. `web_fetch` returns `{ url, contentType, format, content, truncated, fullOutputPath? }`. Scripts cannot read the private spill file, so `content` holds more than the model sees: the Search Provider's complete answer (at most 256 KiB), or the converted page up to 1 MiB, cut on a character boundary with `truncated` set for longer pages. The text the model reads and error behavior are unchanged.

`web_search` no longer puts the current calendar year in its tool description, so the definition does not change when Pi starts in a new year. Pi appends a one-line result summary to both tool descriptions once.
