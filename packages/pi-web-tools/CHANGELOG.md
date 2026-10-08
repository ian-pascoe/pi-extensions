# @ian-pascoe/pi-web-tools

## 0.5.1

### Patch Changes

- Updated dependencies [ac8fb7a]
- Updated dependencies [9b5cae5]
  - @ian-pascoe/pi-utils@0.4.0

## 0.5.0

### Minor Changes

- c24ed51: `web_fetch` now re-indents JSON responses (`application/json`, `text/json`, and `+json` types) with 2 spaces for `markdown` and `text` formats, so `offset` and `limit` can page through minified JSON. Only whitespace changes: strings, numbers, key order, and duplicate keys are kept exactly. Invalid JSON and documents whose re-indented text would exceed 20 MiB are returned unchanged, as is every body with `format: "html"`.

## 0.4.0

### Minor Changes

- db46347: `web_search` now cuts Search Provider text at 6,000 characters when `contextMaxCharacters` is omitted (an explicit value up to 50,000 still overrides it), and `web_fetch` accepts line-based `offset` and `limit`, like Pi's `read` tool, and ends a result that stops early with a continuation note naming the `offset` to continue from. Breaking for `codemode` scripts: `web_search` `structuredContent.content` is now capped at 6,000 characters by default, and `web_fetch` `content` and `full_output_path` hold only the requested `offset`/`limit` window; scripts also get `total_lines` and `next_offset` when they pass a window.

## 0.3.1

### Patch Changes

- ea46e80: Web Fetch no longer drops a page body whose content column has `role="navigation"`, and says how much text chrome removal dropped and how to get the full page.

## 0.3.0

### Minor Changes

- fbfa353: Web Fetch now returns the main content of an HTML page in `markdown` and `text` formats instead of navigation menus and other site chrome (a Wikipedia article used to begin with 251 KB of menus). It uses the first `<main>` or `[role=main]`, else the page's only `<article>`, else the `<body>` without `<nav>`, `<aside>`, and page-level `<header>` and `<footer>`, and converts the whole page when none of these applies. The result keeps the page title and, when something was removed, a one-line note that site chrome was removed. `format: "html"` still returns the raw page.

  **Breaking for `codemode` scripts:** Web Fetch `structuredContent.truncated` changes meaning. Before, it meant `content` was cut at 1 MiB, so a script could see `truncated: false` next to a `full_output_path`. Now `truncated` means the model-visible output was cut at 50 KiB or 2,000 lines and is `true` exactly when `full_output_path` is present, as in pi-lsp. The 1 MiB cut moves to the new required `structured_truncated` field. Scripts that tested `truncated` to detect an incomplete `content` must test `structured_truncated` instead; `structured_truncated: true` always comes with `truncated: true`. Web Search is unchanged.

- 0b9e6a7: **Breaking:** Web Search drops the parameters neither Search Provider honors and makes the rest real. Live provider schemas show that Exa's `web_search_exa` accepts only `query`, `objective`, and `numResults`, and that Parallel's `web_search` accepts no tuning fields.

  - `type` and `livecrawl` are removed from the `web_search` schema and are no longer sent to Exa. A call that passes either now fails Pi's argument validation instead of being silently ignored.
  - `contextMaxCharacters` changes meaning. It was an Exa-only hint that Exa no longer reads; it is no longer sent to Exa, and is now a limit Pi applies to the provider text for both providers. Text longer than the limit is cut at that many Unicode code points and ends with `[Search results cut at N characters]`. Without it, all text is returned, up to the 256 KiB response limit. The cut text is also what scripts receive in `structuredContent.content`.
  - `numResults` now also works for Parallel. Pi trims Parallel's JSON `results` list to the requested count; other text is returned unchanged. Exa still receives it. Parallel calls without `numResults` now return at most 8 results (the default), where Parallel returns 10 on its own.
  - Pi now sends Exa the query as `objective` (cut to the 4096 characters Exa allows), which its current schema requires.

  Parameter descriptions state this behavior and are identical for every session, so the prompt cache is unaffected by which Search Provider a session selects.

### Patch Changes

- 6400244: Web Fetch errors now keep their cause instead of only `Unable to fetch <url>`. The message names the HTTP status (`HTTP 404 Not Found`), the unsupported content type with a suggestion to download and convert binary documents such as PDFs locally, the invalid or non-HTTP URL reason, the timeout, the network error class (`ECONNREFUSED`, `ENOTFOUND`), or the 5 MiB response limit. URL credentials stay redacted. The troubleshooting Skill hint now appears only for server (5xx), network, and timeout failures, not for client errors, invalid input, unsupported types, size limits, or cancellation.
- 9f8825a: Web Search errors now keep their cause instead of only `Unable to search the web for <query>`. Search Provider failures that arrive with HTTP 200 are no longer reported as results or generic failures: an MCP `isError` result (Exa and Parallel), a JSON-RPC `error` object (Parallel), and Exa's free-tier rate limit (`ai.exa/rateLimited`) now throw with the provider's message, bounded to a short line. Errors also name the HTTP status, timeout, or network error class. An empty or whitespace-only query is rejected before any request. HTTP error responses append the provider's JSON-RPC message when it sends one, and a 200 response that is not valid JSON-RPC is reported as an unrecognized response rather than as no results. The troubleshooting Skill hint appears only for server (5xx), network, timeout, rate-limit, and key (HTTP 401/403/429) failures, not for other client errors, provider rejections, or cancellation. Provider messages are stripped of terminal control and invisible characters, and API keys are redacted before any message is bounded.

## 0.2.0

### Minor Changes

- 98b14ae: `web_search` and `web_fetch` now declare an `outputSchema` and return `structuredContent`, so a Pi `codemode` script receives an object instead of text. `web_search` returns `{ provider, content, full_output_path? }`. `web_fetch` returns `{ url, content_type, format, content, truncated, full_output_path? }`. Field names are snake_case, like Pi's `bash` and `pi-termctrl`; persisted `details` keep their existing shape. Scripts cannot read the private spill file, so `content` holds more than the model sees: the Search Provider's complete answer (at most 256 KiB), or the converted page up to 1 MiB, cut on a character boundary with `truncated` set for longer pages. The text the model reads and error behavior are unchanged.

  `web_search` no longer puts the current calendar year in its tool description, so the definition does not change when Pi starts in a new year. Pi appends a one-line result summary to both tool descriptions once.

- bf36a67: `web_search` and `web_fetch` now declare MCP-style tool `annotations`: read-only, non-destructive, idempotent, and open-world. Pi reports them through `pi.getAllTools()`, so permission extensions no longer fall back to the pessimistic defaults for a tool that is not read-only, may be destructive, and may reach an open world. Annotations are not sent to model providers, so tool declarations, the system prompt, and the prompt cache prefix are unchanged.

### Patch Changes

- 0ea1e75: Declare Pi `>=0.99.0` as the peer range for `@earendil-works/pi-coding-agent`, `pi-ai`, `pi-agent-core`, and `pi-tui`, replacing `*`. Installing against an older Pi now warns at install time instead of failing when a package uses an API that Pi release lacks. Pi Utils keeps its Pi peer optional.
- Updated dependencies [0ea1e75]
  - @ian-pascoe/pi-utils@0.3.1

## 0.1.5

### Patch Changes

- 2daa891: Bundled troubleshooting Skills no longer appear in the model's system prompt. Each now sets `disable-model-invocation: true`, so installing the package adds no per-turn context and you no longer need `skills` package filters to hide them. To open one, use `/skill:<package>` or a `$<package>` Skill Reference. Packages whose failures the model can see append that package's Skill path to configuration and runtime failures, so the model loads the guide only when one occurs.

## 0.1.4

### Patch Changes

- be50c8c: Add `stripControlCharacters` to `@ian-pascoe/pi-utils` and use it for transcript text sanitization in Context Management and Web Tools.
- Updated dependencies [be50c8c]
- Updated dependencies [be50c8c]
  - @ian-pascoe/pi-utils@0.3.0

## 0.1.3

### Patch Changes

- b3e76d2: Simplify internal failure handling while preserving credential-safe tool errors, bounded response reads, cancellation, retries, and private output spills.

## 0.1.2

### Patch Changes

- 1a2e2b9: Remove lint workarounds from package code

## 0.1.1

### Patch Changes

- 9b5c7c2: Update dependencies

## 0.1.0

### Minor Changes

- abe75a6: Add bounded Web Search and Web Fetch tools for Pi.
