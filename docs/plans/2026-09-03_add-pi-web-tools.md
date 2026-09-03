# Add Pi Web Tools

**Status:** Needs release-mechanics decision

## Outcome

Add the publishable `@ian-pascoe/pi-web-tools` Pi extension with two model tools:

- `web_search` discovers current public web information through Exa or Parallel.
- `web_fetch` retrieves one HTTP or HTTPS URL as text, Markdown, or HTML.

Match the observable behavior of OpenCode's current V2 tools while using Pi's public extension API and native Node facilities. Keep the package keyless by default, textual, bounded, and free of settings, commands, custom rendering, browser automation, JavaScript execution, extension-owned crawling, and citation rewriting. A Search Provider may perform requested live crawling.

Read before implementation:

- [`../../AGENTS.md`](../../AGENTS.md), [`../../CONTEXT-MAP.md`](../../CONTEXT-MAP.md), and [`../../packages/pi-web-tools/CONTEXT.md`](../../packages/pi-web-tools/CONTEXT.md) for repository rules and canonical Web Search, Web Fetch, and Search Provider language.
- Repository-wide [`ADR-0001`](../adr/0001-package-naming-strategy.md) and [`ADR-0002`](../adr/0002-publish-pi-extensions-as-source-typescript.md) for scoped naming and source-TypeScript packaging.
- [`../releases.md`](../releases.md) for initial package bootstrap and trusted publishing.
- Pi's [custom-tool, failure, cancellation, and output-truncation contracts](../../.repos/pi/packages/coding-agent/docs/extensions.md) and its [`hello.ts`](../../.repos/pi/packages/coding-agent/examples/extensions/hello.ts) and [`truncated-tool.ts`](../../.repos/pi/packages/coding-agent/examples/extensions/truncated-tool.ts) examples.
- OpenCode's current [`websearch.ts`](../../.repos/opencode/packages/core/src/tool/websearch.ts), [`webfetch.ts`](../../.repos/opencode/packages/core/src/tool/webfetch.ts), bounded [HTTP body reader](../../.repos/opencode/packages/core/src/tool/http-body.ts), and their [`websearch`](../../.repos/opencode/packages/core/test/tool-websearch.test.ts) and [`webfetch`](../../.repos/opencode/packages/core/test/tool-webfetch.test.ts) tests as behavioral references. Follow source and tests where older prose claims HTTP is upgraded to HTTPS.
- The `coding-standards` references for external schemas, expected failures, credentials, testing, TypeScript safety, imports, and documentation. Load `writing-for-agents` before creating the package skill.

No ADR is warranted: provider mechanics are isolated and reversible, and the package follows existing repository architecture.

## Tool contract

### `web_search`

Register an active tool named `web_search` with the full OpenCode input surface:

| Parameter              | Contract                                                         |
| ---------------------- | ---------------------------------------------------------------- |
| `query`                | required string                                                  |
| `numResults`           | optional integer from 1 through 20; default 8                    |
| `livecrawl`            | optional `fallback` or `preferred`; default `fallback`           |
| `type`                 | optional `auto`, `fast`, or `deep`; default `auto`               |
| `contextMaxCharacters` | optional integer from 1 through 50,000; effective default 10,000 |

Use label `Web Search` and prompt snippet `Search the web for current information`. Use `StringEnum` for string enums so the schema remains compatible with Google models. The description says Web Search is for discovery, names the model-visible truncation limit, and includes the current year computed when the extension loads.

Select a Search Provider once per call from `context.sessionManager.getSessionId()` using OpenCode's FNV-1a checksum parity. Selection is stable within a session and roughly splits sessions between `exa` and `parallel`; API-key presence never changes selection.

Call the selected hosted MCP endpoint directly:

- Exa: `https://mcp.exa.ai/mcp`, tool `web_search_exa`, arguments `{ query, type, numResults, livecrawl, contextMaxCharacters? }`; append an optional `EXA_API_KEY` as `exaApiKey` in the endpoint query. Omit `contextMaxCharacters` when absent so Exa applies its effective 10,000-character default.
- Parallel: `https://search.parallel.ai/mcp`, tool `web_search`, arguments `{ objective: query, search_queries: [query], session_id }`; send an optional `PARALLEL_API_KEY` as a bearer token and identify the client with `User-Agent: pi-web-tools`. Its protocol has no fields for the Exa tuning controls, so it ignores them.

Both calls POST `{ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": ... }` with `Content-Type: application/json` and `Accept: application/json, text/event-stream`, and have one 25-second total deadline. Parse a direct JSON response first, then exact `data: ` SSE frames, through a TypeBox-owned MCP response schema. Return the first non-empty text content unchanged; return `No search results found. Please try a different query.` when no text exists. Do not parse citations, retry, or fall back to the other provider.

Return details with this exact shape; omit `truncation` when output fits:

```ts
{
  provider: "exa" | "parallel";
  truncation?: WebToolTruncationDetails;
}
```

### `web_fetch`

Register an active tool named `web_fetch` with label `Web Fetch`, prompt snippet `Fetch one HTTP or HTTPS URL as text, Markdown, or HTML`, and this input:

| Parameter | Contract                                                           |
| --------- | ------------------------------------------------------------------ |
| `url`     | required absolute HTTP or HTTPS URL                                |
| `format`  | optional `text`, `markdown`, or `html`; default `markdown`         |
| `timeout` | optional number greater than 0 and at most 120 seconds; default 30 |

Parse the URL before transport. Preserve HTTP URLs, follow native-fetch redirects, and allow loopback, link-local, and private-network destinations in Pi's local trust model. Reject every non-HTTP scheme before I/O.

Send one GET with OpenCode's format-weighted `Accept` header, `Accept-Language: en-US,en;q=0.9`, and its browser user agent. Require an OK response. When a `403` response has `cf-mitigated: challenge`, cancel its body and retry exactly once inside the original timeout budget with `User-Agent: pi-web-tools`; apply no other retry policy.

Normalize MIME types by taking the segment before `;`, trimming it, and lowercasing it. Accept an absent MIME type, `text/*`, JSON, XML, JavaScript, and structured `+json` or `+xml` types. SVG is textual XML. Reject other images and files. Decode accepted bytes as UTF-8. Convert only `text/html` responses:

- `markdown`: use `turndown` with ATX headings, `---` rules, `-` bullets, fenced code, and `*` emphasis; remove `script`, `style`, `meta`, and `link`.
- `text`: use `htmlparser2`, omit `script`, `style`, `noscript`, `iframe`, `object`, and `embed` contents, then trim the extracted text.
- `html`: return the HTML unchanged.

Return converted content in model-visible `content`. Return details with this exact shape; omit `truncation` when output fits:

```ts
{
  url: string; // final redirected URL
  contentType: string; // original response header, or "" when absent
  format: "text" | "markdown" | "html";
  truncation?: WebToolTruncationDetails;
}
```

### Network, output, and failure boundary

Use native `fetch`, `URL`, `TextDecoder`, `AbortSignal.timeout`, and `AbortSignal.any`. Combine the caller's cancellation signal with the tool deadline. A Cloudflare retry shares that deadline rather than resetting it.

Read response streams incrementally. Reject a declared or streamed body above 256 KiB for Web Search or 5 MiB for Web Fetch, cancel the reader immediately on overflow, and never buffer beyond the applicable cap.

Apply Pi's `truncateHead` limit of 50 KiB or 2,000 lines to the parsed search text or converted fetched content. Reserve enough space for the notice so final model-visible content remains within both limits. When truncated, use `withFileMutationQueue` to write the complete post-conversion text with mode `0o600` inside a unique private temporary directory. Include the path and exact counts in the notice and this shared details value, then let normal OS temporary-file cleanup own its lifetime:

```ts
type WebToolTruncationDetails = {
  outputLines: number;
  totalLines: number;
  outputBytes: number;
  totalBytes: number;
  fullOutputPath: string;
};
```

Read `EXA_API_KEY` and `PARALLEL_API_KEY` once at extension composition. Wrap present values as redacted configuration, unwrap only while constructing the final Exa URL or Parallel authorization header, and never include credentials in content, details, errors, temp files, or test snapshots.

Keep expected URL, transport, status, timeout, size, MIME, parsing, conversion, and spill failures as owner-specific tagged errors until each Pi tool's execution boundary. Because Pi marks failures only when `execute` throws, translate there to the stable model-facing messages `Unable to search the web for <query>` and `Unable to fetch <url>`. Redact URL userinfo in the fetch message. Preserve caller cancellation as a failure without exposing transport internals or credentials.

## Intended files

| File or area                                                          | Responsibility                                                                                                                |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `packages/pi-web-tools/src/index.ts`                                  | Read redacted environment configuration, register the two tool definitions, and perform no other startup I/O                  |
| `packages/pi-web-tools/src/web-search.ts`                             | Own provider selection, provider request translation, MCP response parsing, search failures, and the `web_search` definition  |
| `packages/pi-web-tools/src/web-fetch.ts`                              | Own URL/MIME policy, headers, Cloudflare retry, HTML conversion, fetch failures, and the `web_fetch` definition               |
| `packages/pi-web-tools/src/web-response.ts`                           | Incrementally read and cancel bounded native `Response` bodies for both tools                                                 |
| `packages/pi-web-tools/src/web-tool-output.ts`                        | Apply Pi truncation and create private full-output temporary spills                                                           |
| `packages/pi-web-tools/test/*.test.ts`                                | Verify both registered tools through real definitions, faithful fetch functions, local HTTP servers, and real temporary files |
| `packages/pi-web-tools/package.json`, `tsconfig.json`, `LICENSE`      | Define the source-TypeScript package, runtime/parser dependencies, Pi peers, and package checks                               |
| `packages/pi-web-tools/README.md`                                     | Document installation, parameters, providers, keys, limits, temp spills, and the trusted-network boundary                     |
| `packages/pi-web-tools/skills/pi-web-tools/SKILL.md`                  | Route missing-tool, provider, fetch, truncation, and key diagnosis to the README and concrete checks                          |
| root `package.json`, `README.md`, and `pnpm-lock.yaml`                | Add Git-collection loading, discoverability, dependencies, and focused commands                                               |
| `scripts/check-package-packs.mjs` and `scripts/check-git-install.mjs` | Advance the explicit package/extension/skill counts while preserving order and source-entrypoint assertions                   |
| `docs/releases.md`                                                    | Add the package to bootstrap and trusted-publishing instructions                                                              |

Keep errors and redacted credentials beside their owners. Add no generic HTTP client, provider interface, settings model, retry framework, cache, renderer, command, or barrel beyond the intentional package entrypoint.

## Implementation sequence

### 1. Establish the package and public schemas

Record the baseline:

```bash
git status --short
git rev-parse HEAD
pnpm verify
```

After resolving the release decision in step 5, create the package following the existing source-TypeScript manifests and TypeScript configuration. Declare `htmlparser2@8.0.2` and `turndown@7.2.0` as runtime dependencies, `@types/turndown@5.0.5` as a development dependency, and Pi AI, Pi Coding Agent, and TypeBox as wildcard peers. Do not add `main`, `types`, `exports`, build, or prepack fields.

Add tests that load the default extension, capture exactly two definitions named `web_search` and `web_fetch`, parse accepted defaults, and reject every documented bound or enum violation. Assert labels, prompt snippets, and descriptions disclose the agreed behavior and Pi output limits. Add later execution cases as explicit red tests before each implementation slice rather than leaving this contract step red.

**Complete when:** the new package typechecks structurally and registration/schema contract tests pass through the real entrypoint.

### 2. Build the bounded response and output seams

Implement incremental native-response reading with `Content-Length` preflight, streamed size enforcement, cancellation on overflow, and caller/timeout abortion. Test exact-limit acceptance, declared overflow, streamed overflow, reader cancellation, and aborted reads without module mocking.

Implement truncation and private temporary spills using Pi's exported helpers and real filesystem tests. Cover byte and line limits independently, a non-truncated result with no file, a truncated result whose final notice stays in bounds, exact counts, readable complete content, and details that name the same path.

**Complete when:** both shared seams are independently bounded, cancellation-safe, credential-agnostic, and green under focused tests.

### 3. Implement Web Search through both provider protocols

Test provider selection and protocol behavior before wiring transport:

- exact stable FNV-1a parity for representative session IDs;
- Exa defaults, optional controls, endpoint query credential, and JSON-RPC body;
- Parallel session ID, bearer credential, user agent, and JSON-RPC body;
- direct JSON, SSE with ignored non-JSON frames, absent text, malformed payload, non-OK status, timeout, caller cancellation, and 256-KiB overflow;
- key values absent from every success, failure, details, and spill; and
- selected-provider failure issuing one request with no fallback.

Let the tool-definition constructor accept native fetch plus endpoint options as the smallest outbound capability seam. Production passes `globalThis.fetch` and the fixed hosted endpoints; tests inject local HTTP endpoints and exercise both providers through native fetch. Reserve a recording fetch function for transport states a local server cannot represent cheaply. Exercise the completed definition through Pi's `execute` signature and a real `ExtensionContext` so session selection and thrown failure behavior are covered.

**Complete when:** both hosted MCP dialects produce the agreed request, accepted responses return unchanged provider text, all known failures reach Pi as the stable generic error, and no credential crosses the transport boundary.

### 4. Implement Web Fetch end to end

Drive `web_fetch` through its real definition with local Node HTTP fixtures and a faithful fetch function for response cases that a fixture cannot express cheaply. Cover:

- unchanged ordinary HTTP, HTTPS parsing, localhost, redirects, and final-URL details;
- scheme rejection before transport;
- format-specific request headers and HTML-to-Markdown/text conversion without active content;
- unchanged plain text, Markdown, JSON, XML, JavaScript, and raw HTML;
- absent MIME and SVG acceptance plus image/PDF rejection;
- declared and streamed 5-MiB overflow;
- caller cancellation and the 30-second default/custom deadline bounds;
- one Cloudflare challenge retry with the honest user agent, one shared deadline, and no retry for ordinary failures; and
- Pi truncation with complete converted output available at the returned temp path.

Use default native redirect behavior. Do not add HTTPS rewriting, private-network filtering, cookie storage, decompression code, browser execution, or link traversal.

**Complete when:** every accepted content path returns the agreed model text/details, every rejected path throws the stable Pi-facing error, resources close on all paths, and focused tests pass.

### 5. Integrate package documentation and release contracts

Write `packages/pi-web-tools/README.md` with npm/local installation, both schemas, anonymous Exa/Parallel behavior, optional keys, deterministic per-session selection, limits, temporary spill behavior, lack of fallback/citations/browser execution, and the explicit security warning that URLs and queries leave the machine and private-network URLs are permitted.

Create the model-invoked package skill using `writing-for-agents`. Its frontmatter description should trigger only for missing `web_search`/`web_fetch`, provider failures, fetch/content failures, truncation spills, or API-key diagnosis. Keep the body as ordered diagnostic steps with checkable completion criteria; point to the README rather than duplicating configuration and limits.

Add the package extension and skill to the root Pi manifest and README lists, plus its network/key prerequisite and focused typecheck/test commands. Update both package-install scripts from 11 packages/10 extensions and skills to 12 packages/11 extensions and skills, including their final messages. Update `docs/releases.md` to list the eleventh extension package and twelve active packages.

Resolve one release conflict before creating the manifest:

- The accepted interview decision was version `0.0.0` plus a minor Changeset, producing `0.1.0` in the version PR.
- The current [`docs/releases.md`](../releases.md) contract bootstraps new scoped packages manually at committed version `0.1.0` with no bootstrap Changeset.

The existing repository policy is recommended because changing it is outside this package's scope. Implementation remains paused until the user explicitly chooses the existing policy or approves a release-policy change. Update `docs/releases.md` to match that choice and document subsequent trusted-publishing setup.

Run `pnpm install` to update the lockfile after manifests are final. Retain the existing glossary and context-map entries; add no implementation detail to `CONTEXT.md` and no ADR.

**Complete when:** source, package metadata, README, skill pointer/body, root collection, install checks, release docs, and lockfile describe one consistent package and contain no copied configuration cache.

### 6. Verify and smoke-test without publishing

Run:

```bash
pnpm format
pnpm --filter @ian-pascoe/pi-web-tools typecheck
pnpm --filter @ian-pascoe/pi-web-tools test
pnpm pack:check
pnpm git-install:check
pnpm verify
pnpm changeset:status
git diff --check
git status --short
```

Inspect the packed tarball indirectly through `pack:check`: it must load one source entrypoint and one valid skill and contain only the allowed source, skill, README, license, and manifest files plus declared runtime dependencies installed by npm.

Smoke-test the source extension in Pi without publishing:

1. confirm `web_search` and `web_fetch` are active with the exact schemas;
2. run one anonymous current-information search and verify its selected provider appears only in details;
3. fetch an HTTP redirect as Markdown and confirm converted content plus the final URL;
4. fetch a local response above 50 KiB and read the complete private spill from the returned path; and
5. repeat one search with the selected provider's optional key, confirming no key appears in the transcript, errors, or spill.

Automated tests make no live network requests. The smoke is diagnostic only and must not publish, change Pi settings, or persist credentials.

**Complete when:** every command and smoke step passes, package/Git installation discovers eleven extensions and skills in root order, no live-network test entered CI, and the diff contains only this package plus its required repository documentation and integration changes.

## Acceptance checklist

- [ ] `@ian-pascoe/pi-web-tools` loads from source and registers exactly `web_search` and `web_fetch`.
- [ ] Tool names, labels, prompt snippets, parameters, defaults, bounds, descriptions, model content, and exact details shapes match this plan.
- [ ] Exa and Parallel work anonymously and accept only their optional environment key.
- [ ] Provider selection is stable per session; failures never fall back or retry.
- [ ] MCP JSON/SSE parsing is schema-owned and provider text passes through without citation rewriting.
- [ ] Web Fetch preserves HTTP, follows redirects, permits private hosts, rejects non-HTTP URLs, and returns only textual MIME types.
- [ ] HTML conversion matches the current OpenCode settings and omits active content.
- [ ] Cloudflare challenges receive exactly one honest-user-agent retry inside the original deadline.
- [ ] Search and fetch bodies stop at 256 KiB and 5 MiB; overflow cancels the stream.
- [ ] Caller cancellation and all deadlines stop active network/body work.
- [ ] Final model content never exceeds 50 KiB or 2,000 lines; complete truncated text is readable from a private temp path.
- [ ] API keys are read once, remain redacted, and never enter model content, details, diagnostics, tests, or files.
- [ ] Expected failures become stable Pi error results without leaking transport internals.
- [ ] The package includes only necessary runtime dependencies and no settings, commands, cache, browser, UI, or speculative abstraction.
- [ ] README, package skill, glossary, manifests, install scripts, release docs, and lockfile agree.
- [ ] Focused tests, full verification, package checks, Git-install checks, and smoke tests pass.

## Pause

Do not begin implementation until the user resolves the release-mechanics conflict and explicitly approves this plan in a later turn.
