# Reference MCP servers with `+`

MCP Server References use `+` (`+github`) and no longer share Pi's `@` file-mention popup, which supersedes [ADR-0001](0001-share-at-with-file-mentions.md). The popup is the shared `stackProseReferenceAutocomplete` from `@ian-pascoe/pi-utils/prose-references`, the way `$skill` and `#123` work. A submitted `+github` becomes `[+github](mcp://github "MCP server mcp__github")`. Name rules are unchanged: exact known names only, case-sensitive, `-` and `_` interchangeable, and path-, address-, URI-, escape-, code-, link-, and HTML-shaped text stays literal. `C++`, `a+b`, `+1`, and a Markdown `+ item` bullet are not references.

Sharing `@` failed in practice. `@ff-labs/pi-fff` wraps the autocomplete provider and answers an `@` prefix with its own file results without calling the provider beneath it, so whenever pi-fff wraps ours, servers vanish from the popup. Ordering within one popup is not ours to control, and the native file results are not ours to merge.

## Considered Options

- Keep `@` and win by load order: fragile, since it depends on which extension wraps last, and it still competes with every file-mention provider.
- `&`, `%`, `^`, or another sigil: Pi's editor opens the popup on its own only for `@`, `#`, and the trigger characters the outermost provider declares, and `@` and `#` are taken (files, and GitHub issues). A new character has no advantage over `+`, which reads as "add this server".

## Consequences

- Breaking: `@github` no longer converts, and `@` no longer lists servers. A file named like a server is no longer rewritten to `@./name`.
- Pi opens the popup by itself after `+` only while the outermost provider declares `+` in `triggerCharacters`. An extension that wraps ours without forwarding `triggerCharacters` (pi-fff currently does not) hides it, so the user presses Tab after `+` to open the popup.
- A lone `+` at the start of a line is an empty Markdown list marker, so its popup appears once a name character follows (`+g`).
