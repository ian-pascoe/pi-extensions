---
"@ian-pascoe/pi-advisor": minor
---

Ask for longer prompt-cache retention on Advisor requests only, so a Review after an idle gap no longer re-reads the whole Advisor Session uncached. OpenAI Advisor requests now send `prompt_cache_retention: "24h"` (free). The new `anthropicLongCache` setting (default `false`, also a row in the `/advisor` menu) asks Anthropic for the 1h cache TTL, whose writes cost 2× instead of 1.25×. Retention is a per-request stream option on the Advisor Session, never the process-wide `PI_CACHE_RETENTION`, so the observed agent's requests are unchanged. Codex Advisor sessions are unchanged: Pi's Codex adapter has no retention field. A new test builds the real Codex request body for consecutive Reviews and proves their settings and input prefix are identical; the earlier second-Review miss on Codex is documented in the design doc.
