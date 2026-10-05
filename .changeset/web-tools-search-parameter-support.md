---
"@ian-pascoe/pi-web-tools": minor
---

**Breaking:** Web Search drops the parameters neither Search Provider honors and makes the rest real. Live provider schemas show that Exa's `web_search_exa` accepts only `query`, `objective`, and `numResults`, and that Parallel's `web_search` accepts no tuning fields.

- `type` and `livecrawl` are removed from the `web_search` schema and are no longer sent to Exa. A call that passes either now fails Pi's argument validation instead of being silently ignored.
- `contextMaxCharacters` changes meaning. It was an Exa-only hint that Exa no longer reads; it is no longer sent to Exa, and is now a limit Pi applies to the provider text for both providers. Text longer than the limit is cut at that many Unicode code points and ends with `[Search results cut at N characters]`. Without it, all text is returned, up to the 256 KiB response limit. The cut text is also what scripts receive in `structuredContent.content`.
- `numResults` now also works for Parallel. Pi trims Parallel's JSON `results` list to the requested count; other text is returned unchanged. Exa still receives it. Parallel calls without `numResults` now return at most 8 results (the default), where Parallel returns 10 on its own.
- Pi now sends Exa the query as `objective` (cut to the 4096 characters Exa allows), which its current schema requires.

Parameter descriptions state this behavior and are identical for every session, so the prompt cache is unaffected by which Search Provider a session selects.
