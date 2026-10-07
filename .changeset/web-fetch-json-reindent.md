---
"@ian-pascoe/pi-web-tools": minor
---

`web_fetch` now re-indents JSON responses (`application/json`, `text/json`, and `+json` types) with 2 spaces for `markdown` and `text` formats, so `offset` and `limit` can page through minified JSON. Only whitespace changes: strings, numbers, key order, and duplicate keys are kept exactly. Invalid JSON and documents whose re-indented text would exceed 20 MiB are returned unchanged, as is every body with `format: "html"`.
