# Reference subagent models with `%`

Subagent Model References use `%` (`%claude-opus-5-5`, `%large`). Pi already uses `@` for files, and the sibling selectors use `#` and `!` (issues), `$` (Skills), and `&` (MCP servers). `%` has no Markdown meaning, so the completion popup opens even for a lone `%` at the start of a line, and no other package uses it. Percentages (`50%`), URL escapes (`a%20b`), format specifiers (`%s`), and `%VAR%` stay literal. Each has one of three protections: a word character precedes the sigil, the sigil follows the name, or no exact catalogue name follows it. As with `&`, a provider wrapper that drops `triggerCharacters` means the user presses Tab after `%`.

A submitted reference becomes `[%name](model://provider/id "Subagent model: model=provider/id")` or `[%name](model-role://name "Subagent model role: role=name")`. The title names the `subagent` argument, so the Root Agent does not read the reference as "switch your own model". Names that would need escaping in a link are left out of the Subagent Model Catalogue rather than encoded, because the Root Agent copies the id verbatim into the tool call.

A name may end in `:level`, one of the thinking levels Pi reports its model supports, which adds `thinking_level=<level>` to the title. The suffix follows the `modelRoles` notation (`provider/model:high`) and resolves the same way: the whole text is tried against every eligible model and role name first, so a real id ending in `:text` keeps it, and stays literal when ambiguous. Only supported levels convert, so a link never names a level the spawn would silently clamp; any other `:text` after a name stays literal. Typing `:` after a name lists its levels in the popup.

## Considered Options

- `@`: rejected. It is Pi's file-mention sigil, and pi-mcp-selector's ADR-0002 showed that sharing its popup breaks when another extension wraps the provider.
- `^`: rejected. It is used for footnotes and exponents.
- `~`: rejected. It is used for strikethrough and home paths, and OpenRouter model ids start with `~`.
- `+`: rejected. A lone `+` starts a Markdown list, as pi-mcp-selector's ADR-0002 found.
- Listing every model at every thinking level up front: rejected. It would multiply a catalogue of hundreds of models several times over; the descriptions list each entry's levels instead.
- Percent-encoding unsafe ids: rejected. An encoded id such as `%23` invites the Root Agent to pass the encoded form.
