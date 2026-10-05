---
"@ian-pascoe/pi-web-tools": patch
---

Web Search errors now keep their cause instead of only `Unable to search the web for <query>`. Search Provider failures that arrive with HTTP 200 are no longer reported as results or generic failures: an MCP `isError` result (Exa and Parallel), a JSON-RPC `error` object (Parallel), and Exa's free-tier rate limit (`ai.exa/rateLimited`) now throw with the provider's message, bounded to a short line. Errors also name the HTTP status, timeout, or network error class. An empty or whitespace-only query is rejected before any request. The troubleshooting Skill hint appears only for server (5xx), network, timeout, and rate-limit failures, not for client errors, provider rejections, or cancellation, and API keys are redacted from every message.
