# @ian-pascoe/pi-web-tools

Bounded Web Search and Web Fetch model tools for [Pi](https://github.com/earendil-works/pi). Web Search discovers current public information through Exa or Parallel. Web Fetch retrieves one HTTP or HTTPS URL as text, Markdown, or HTML.

## Install

Pi loads the source extension from this repository:

```bash
pi install git:github.com/ian-pascoe/pi-extensions
```

Select `packages/pi-web-tools/src/index.ts` for a filtered Git installation. After publishing, install the package directly:

```bash
pi install npm:@ian-pascoe/pi-web-tools
```

Requires Node.js 22.19 or newer and Pi `>=0.99.0`.

## Tools

### `web_search`

Searches current public web information. Pi deterministically chooses Exa or Parallel once per session with FNV-1a checksum parity; API-key presence never changes that choice. Both providers support anonymous requests. Set optional process environment keys before starting Pi:

```bash
export EXA_API_KEY=...
export PARALLEL_API_KEY=...
```

| Parameter              | Values           | Default                        | Behavior                                                                                            |
| ---------------------- | ---------------- | ------------------------------ | --------------------------------------------------------------------------------------------------- |
| `query`                | required string  | —                              | Sent to both Search Providers                                                                       |
| `numResults`           | integer 1–20     | 8                              | Exa receives it; for Parallel, Pi trims the returned `results` list to this count                   |
| `contextMaxCharacters` | integer 1–50,000 | none (all text, up to 256 KiB) | Pi cuts the provider text at this many Unicode code points and appends a marker, for both providers |

Neither Search Provider honors `type` or `livecrawl` (their live tool schemas do not declare them), so Web Search no longer accepts them: a call that passes either fails Pi's argument validation. Descriptions are static strings, so the tool definition (and the prompt cache) is identical whichever provider the session selects.

- **`numResults` on Exa.** It is sent as Exa's `numResults`. Pi also sends the query as Exa's required `objective`.
- **`numResults` on Parallel.** Parallel has no count field. Its text is a pretty-printed JSON object with a `results` array; Pi keeps the first `numResults` entries and prints the object the same way. Text that is not that JSON object is returned unchanged.
- **`contextMaxCharacters`.** It is applied in Pi, after the `numResults` trim and before the model-output limits, so `structuredContent.content` and the text the model reads agree. Cut text ends with `[Search results cut at N characters]`. It is never sent to a provider.

Exa receives an optional `EXA_API_KEY` endpoint credential; Parallel receives the query and Pi session ID. Search results are provider text without citation rewriting. A provider failure has no retry and never falls back to the other provider. Failures keep their cause: `Unable to search the web for <query>: <cause>` names the HTTP status, timeout, network error class, or the Search Provider's own message (an MCP `isError` result, a JSON-RPC `error`, or Exa's free-tier rate limit). An empty or whitespace-only query is rejected before any request. API keys never appear in errors.

### `web_fetch`

Fetches exactly one absolute HTTP or HTTPS URL. HTTP is preserved, native fetch redirects are followed, and loopback, link-local, and private-network URLs are permitted in Pi's local trust model.

| Parameter | Values                                    | Default    |
| --------- | ----------------------------------------- | ---------- |
| `url`     | required absolute HTTP or HTTPS URL       | —          |
| `format`  | `text`, `markdown`, or `html`             | `markdown` |
| `timeout` | number greater than 0 through 120 seconds | 30 seconds |

Only textual MIME types are returned: an absent type, `text/*`, JSON, XML, JavaScript, and structured `+json`/`+xml` types. SVG is accepted as XML. Other images and files are rejected. A failure reads `Unable to fetch <url>: <cause>` with URL credentials removed. The cause is the HTTP status (`HTTP 404 Not Found`), `invalid URL`, `unsupported URL scheme`, `unsupported content type` (download the document and convert it to text locally), `timed out after 30 seconds`, `network error <CODE>` such as `ECONNREFUSED`, `response body exceeds the 5 MiB limit`, or `request cancelled`. Only server (5xx), network, and timeout failures point the model to the troubleshooting Skill. HTML converts to Markdown or plain text when requested; scripts and other active embedded content are not executed.

**Main content.** For `markdown` and `text`, an HTML page is reduced to its main content instead of site chrome. Web Fetch uses the first `<main>` or `[role=main]` that holds text, else the page's only `<article>` (an `<article>` inside an `<aside>`, `<nav>`, `<header>`, or `<footer>` is a card, not the page, and is ignored), else the `<body>` without navigation, `<aside>`, and page-level `<header>`/`<footer>` (a `<header>` inside an `<article>` or `<section>` is kept). Navigation means `<nav>` plus any element with `role="navigation"` or `role="search"`, and it is also cut from the selected content. A `<header>` that belongs to the `<main>` itself keeps only its headings, which drops widgets such as a language menu beside the title; a `<header>` inside an `<article>` or `<section>` in the main keeps its byline and summary. The result starts with the page `<title>` (unless the content already opens with it) and, only when text was actually dropped, a one-line note that site chrome was removed; when chrome removal drops more than half of the page's text (and at least 1,000 characters) the note gives the percentage and points to `format: "html"` for the full page. In the `<body>` fallback, a navigation, `<aside>`, `<header>`, or `<footer>` that holds most of the body text is the content column and is kept (some sites mark their content `role="navigation"`), and when the remaining cuts would still drop most of a large page, the whole page converts. A page where nothing qualifies converts whole, as before. Very large pages convert in linear time: long lists and many sibling blocks convert in groups with unchanged Markdown, and an unsplittable fragment over 256 KiB (such as one giant `<table>`) becomes plain text instead of Markdown. `format: "html"` always returns the page unchanged.

A Cloudflare `403` challenge gets one retry with the `pi-web-tools` user agent inside the original timeout budget.

Both tools declare MCP-style `annotations`: read-only, non-destructive, idempotent, and open-world. Pi reports them through `pi.getAllTools()` so permission extensions can decide which calls to confirm; Pi does not send them to model providers.

## Script results

Both tools declare an `outputSchema` and return matching `structuredContent`, so a Pi `codemode` script receives an object instead of the model-facing text. Field names are snake_case, like Pi's `bash` and `pi-termctrl`; the session `details` keep their existing shape. The model still reads the same text, and a failed call still throws.

| Tool         | Script value                                                                                             |
| ------------ | -------------------------------------------------------------------------------------------------------- |
| `web_search` | `{ provider, content, full_output_path? }`                                                               |
| `web_fetch`  | `{ url, content_type, format, content, truncated, structured_truncated, full_output_path? }` (final URL) |

Scripts cannot read the private spill file, so `content` carries more than the model sees. Web Search `content` is the Search Provider's text answer (at most 256 KiB). For Parallel it is its JSON result object trimmed to `numResults`. `contextMaxCharacters` can cut it and appends a marker, which can leave Parallel's JSON unparseable. For Web Search, `full_output_path` appears whenever the model-visible text was truncated and names the file with the trimmed and cut text. Web Fetch `content` is the converted text up to 1 MiB of UTF-8, cut on a character boundary.

Web Fetch reports two separate cuts, as pi-lsp does:

- `truncated` — the **model-visible** output was cut at 50 KiB or 2,000 lines. It is `true` exactly when `full_output_path` is present, and that file holds the complete text.
- `structured_truncated` — `content` itself was cut at 1 MiB, so the page is longer than the script received. It is always accompanied by `truncated: true`; read `full_output_path` for the rest.

So `truncated: true` with `structured_truncated: false` means `content` is already complete and only the model's view was shortened.

Search results stay provider text, so the schema does not invent result fields: Exa returns prose and snippets, and Parallel returns a JSON object whose `results` Pi trims. It adds the selected `provider` and the text after the `numResults` trim and `contextMaxCharacters` cut.

## Limits and security

Web Search response bodies stop at 256 KiB. Web Fetch response bodies stop at 5 MiB. Both tools apply Pi's 50 KiB or 2,000-line model-output limit after parsing or conversion. When output is truncated, the complete text is written to a unique private temporary directory and the returned result includes its path and exact counts. Script results are bounded separately, as described above. The operating system owns later temporary-file cleanup.

Queries and URLs leave the machine for their Search Provider or requested host. Web Fetch intentionally permits private-network destinations, so use it only where the model and extension are trusted. The package provides no browser automation, JavaScript execution, extension-owned crawling, cookie storage, cache, settings, commands, or citation rewriting.

API keys are read once when the extension loads, used only to construct the final provider request, and never intentionally included in model content, result details, errors, or temporary files.

## License

MIT
