---
"@ian-pascoe/pi-web-tools": minor
---

Web Fetch now returns the main content of an HTML page in `markdown` and `text` formats instead of navigation menus and other site chrome (a Wikipedia article used to begin with 251 KB of menus). It uses the first `<main>` or `[role=main]`, else the page's only `<article>`, else the `<body>` without `<nav>`, `<aside>`, and page-level `<header>` and `<footer>`, and converts the whole page when none of these applies. The result keeps the page title and, when something was removed, a one-line note that site chrome was removed. `format: "html"` still returns the raw page.

**Breaking for `codemode` scripts:** Web Fetch `structuredContent.truncated` changes meaning. Before, it meant `content` was cut at 1 MiB, so a script could see `truncated: false` next to a `full_output_path`. Now `truncated` means the model-visible output was cut at 50 KiB or 2,000 lines and is `true` exactly when `full_output_path` is present, as in pi-lsp. The 1 MiB cut moves to the new required `structured_truncated` field. Scripts that tested `truncated` to detect an incomplete `content` must test `structured_truncated` instead; `structured_truncated: true` always comes with `truncated: true`. Web Search is unchanged.
