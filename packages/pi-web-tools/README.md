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

Requires Node.js 22.19 or newer and a compatible Pi installation.

## Tools

### `web_search`

Searches current public web information. Pi deterministically chooses Exa or Parallel once per session with FNV-1a checksum parity; API-key presence never changes that choice. Both providers support anonymous requests. Set optional process environment keys before starting Pi:

```bash
export EXA_API_KEY=...
export PARALLEL_API_KEY=...
```

| Parameter              | Values                    | Default                       |
| ---------------------- | ------------------------- | ----------------------------- |
| `query`                | required string           | —                             |
| `numResults`           | integer 1–20              | 8                             |
| `livecrawl`            | `fallback` or `preferred` | `fallback`                    |
| `type`                 | `auto`, `fast`, or `deep` | `auto`                        |
| `contextMaxCharacters` | integer 1–50,000          | Exa effective default: 10,000 |

Exa receives all controls and an optional `EXA_API_KEY` endpoint credential. Parallel receives the query and Pi session ID; its protocol has no matching tuning fields. Search results are provider text without citation rewriting. A provider failure has no retry and never falls back to the other provider.

### `web_fetch`

Fetches exactly one absolute HTTP or HTTPS URL. HTTP is preserved, native fetch redirects are followed, and loopback, link-local, and private-network URLs are permitted in Pi's local trust model.

| Parameter | Values                                    | Default    |
| --------- | ----------------------------------------- | ---------- |
| `url`     | required absolute HTTP or HTTPS URL       | —          |
| `format`  | `text`, `markdown`, or `html`             | `markdown` |
| `timeout` | number greater than 0 through 120 seconds | 30 seconds |

Only textual MIME types are returned: an absent type, `text/*`, JSON, XML, JavaScript, and structured `+json`/`+xml` types. SVG is accepted as XML. Other images and files are rejected. HTML converts to Markdown or plain text when requested; scripts and other active embedded content are not executed. A Cloudflare `403` challenge gets one retry with the `pi-web-tools` user agent inside the original timeout budget.

## Limits and security

Web Search response bodies stop at 256 KiB. Web Fetch response bodies stop at 5 MiB. Both tools apply Pi's 50 KiB or 2,000-line model-output limit after parsing or conversion. When output is truncated, the complete text is written to a unique private temporary directory and the returned result includes its path and exact counts. The operating system owns later temporary-file cleanup.

Queries and URLs leave the machine for their Search Provider or requested host. Web Fetch intentionally permits private-network destinations, so use it only where the model and extension are trusted. The package provides no browser automation, JavaScript execution, extension-owned crawling, cookie storage, cache, settings, commands, or citation rewriting.

API keys are read once when the extension loads, used only to construct the final provider request, and never intentionally included in model content, result details, errors, or temporary files.

## License

MIT
