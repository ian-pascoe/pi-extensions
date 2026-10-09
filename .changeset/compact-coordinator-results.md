---
"@ian-pascoe/pi-minimal-subagents": minor
---

Coordinator Tools now give the model compact text instead of pretty-printed JSON. `subagent_status` lists each tool set once and previews long fields, with a new `verbose` option for the full detail; `subagent_wait` reports one token/cost total; and a `subagent_cancel` that found nothing running says so. Codemode scripts still receive the complete record in `structuredContent`.
