---
"@ian-pascoe/pi-web-tools": patch
---

Web Fetch errors now keep their cause instead of only `Unable to fetch <url>`. The message names the HTTP status (`HTTP 404 Not Found`), the unsupported content type with a suggestion to download and convert binary documents such as PDFs locally, the invalid or non-HTTP URL reason, the timeout, the network error class (`ECONNREFUSED`, `ENOTFOUND`), or the 5 MiB response limit. URL credentials stay redacted. The troubleshooting Skill hint now appears only for server (5xx), network, and timeout failures, not for client errors, invalid input, unsupported types, size limits, or cancellation.
