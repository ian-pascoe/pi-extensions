---
"@ian-pascoe/pi-context-management": minor
---

Return the whole Note from `context_notes` `read` unless `offset`/`limit` select a range, instead of stopping at 2,000 characters. History reads still return at most 2,000 characters per call. Tool descriptions, errors, and transcript rows now say "characters" instead of "UTF-16 units".
