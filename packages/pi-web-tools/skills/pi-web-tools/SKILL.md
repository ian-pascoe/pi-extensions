---
name: pi-web-tools
description: Diagnose missing web_search or web_fetch tools, Search Provider failures, Web Fetch content failures, truncation spills, or Web Tools API-key problems.
license: MIT
disable-model-invocation: true
---

# Pi Web Tools

1. Confirm `packages/pi-web-tools/src/index.ts` is installed and active, then reload Pi. Finish when both `web_search` and `web_fetch` are available.
2. For a search failure, check outbound network access to the selected Exa or Parallel provider. Read the provider and key section of [`../../README.md`](../../README.md); set only the selected provider's optional environment key, restart Pi, and repeat one search. Finish when it returns provider text or the generic failure identifies an external outage.
3. For a fetch failure, read the cause after `Unable to fetch <url>:`. `HTTP 4xx`, `invalid URL`, `unsupported URL scheme`, and `unsupported content type` are not setup faults: fix the URL, or download a binary document such as a PDF and convert it to text locally. For `HTTP 5xx`, `network error <CODE>` (for example `ECONNREFUSED` or `ENOTFOUND`), or `timed out`, check that the URL is reachable from this machine and raise `timeout` (up to 120 seconds) if needed. Read the Web Fetch section of [`../../README.md`](../../README.md). Finish when one request returns the expected final URL and format.
4. For truncated output, read the returned private spill path with Pi's `read` tool. Finish when it contains the complete result and the model-visible output remains bounded.
5. For an API-key problem, confirm `EXA_API_KEY` or `PARALLEL_API_KEY` is present in Pi's process environment without printing its value, then restart Pi. Finish when requests work without a key appearing in output, details, errors, or spill files.
