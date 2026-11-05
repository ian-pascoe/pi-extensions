# Reference subagent models with `%`

Subagent Model References use `%` (`%claude-opus-5-5`, `%large`). Pi already uses `@` for files, and the sibling selectors use `#` and `!` (issues), `$` (Skills), and `&` (MCP servers). `%` has no Markdown meaning, so the completion popup opens even for a lone `%` at the start of a line, and no other package uses it. Percentages (`50%`), URL escapes (`a%20b`), format specifiers (`%s`), and `%VAR%` stay literal. Each has one of three protections: a word character precedes the sigil, the sigil follows the name, or no exact catalogue name follows it. As with `&`, a provider wrapper that drops `triggerCharacters` means the user presses Tab after `%`.

A submitted reference becomes `[%name](model://provider/id "Subagent model: model=provider/id")` or `[%name](model-role://name "Subagent model role: role=name")`. The title names the `subagent` argument, so the Root Agent does not read the reference as "switch your own model". Names that would need escaping in a link are left out of the Subagent Model Catalogue rather than encoded, because the Root Agent copies the id verbatim into the tool call.

## Considered Options

- `@`: rejected. It is Pi's file-mention sigil, and pi-mcp-selector's ADR-0002 showed that sharing its popup breaks when another extension wraps the provider.
- `^`: rejected. It is used for footnotes and exponents.
- `~`: rejected. It is used for strikethrough and home paths, and OpenRouter model ids start with `~`.
- `+`: rejected. A lone `+` starts a Markdown list, as pi-mcp-selector's ADR-0002 found.
- Percent-encoding unsafe ids: rejected. An encoded id such as `%23` invites the Root Agent to pass the encoded form.
