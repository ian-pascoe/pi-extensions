# Reference MCP servers with `&`

MCP Server References use `&` (`&github`) and no longer share Pi's `@` file-mention popup, which supersedes [ADR-0001](0001-share-at-with-file-mentions.md). The popup is the shared `stackProseReferenceAutocomplete` from `@ian-pascoe/pi-utils/prose-references`, the way `$skill` and `#123` work. A submitted `&github` becomes `[&github](mcp://github "MCP server mcp__github")`. Name rules are unchanged: exact known names only, case-sensitive, `-` and `_` interchangeable, and path-, address-, URI-, escape-, code-, link-, and HTML-shaped text stays literal. `R&D`, `Q&A`, `a && b`, `Q & A`, and Rust's `&self` are not references unless a server has that exact name. An HTML entity is never a reference, even when a server has the entity's name: `&amp;` would otherwise convert, because the shared Prose Span mapping reads the raw `&amp` as text, so the grammar refuses a name directly followed by `;`.

Sharing `@` failed in practice. `@ff-labs/pi-fff` (0.11.0) wraps the autocomplete provider and answers an `@` prefix with its own file results without calling the provider beneath it, so whenever pi-fff wraps ours, servers vanish from the popup. Ordering within one popup is not ours to control, and the native file results are not ours to merge.

`&` reads as "a reference to the server" (address-of in C and Rust), and it is plain text in Markdown, so the popup works even for a lone `&` at the start of a line. `&#123` stays literal for issues, because pi-issues-selector excludes `&` before `#` so that an HTML entity is not an issue reference.

## Considered Options

- `+`: rejected. A lone `+` at the start of a line is a Markdown list marker, so the popup has to wait for a name character, and `+` reads as "add this server", which a reference does not do.
- `$`, like Codex: rejected. Codex has no MCP-specific sigil; its `$` popup covers Skills and Apps, its plugins use `@` together with files, and it honours `[$server](mcp://server)` links by requiring that server ready for the turn. Our links only point. `$` is also taken by pi-skills-selector, and sharing one sigil between two providers reintroduces the stacking problem ADR-0001 hit.
- Keep `@`: rejected for the pi-fff interference above, and because it competes with every file-mention provider. Winning by load order is fragile.
- `%`, `^`, or another sigil: Pi's editor opens the popup on its own only for `@`, `#`, and the characters the outermost provider lists in `triggerCharacters`, and `@` and `#` are taken (files, and GitHub issues). Nothing else reads as naturally as `&`.

## Consequences

- Breaking: `@github` no longer converts, and `@` no longer lists servers. A file named like a server is no longer rewritten to `@./name`.
- Pi opens the popup by itself after `&` only while the outermost provider declares `&` in `triggerCharacters`. An extension that wraps ours without forwarding `triggerCharacters` (pi-fff 0.11.0 does not) hides it, so the user presses Tab after `&` to open the popup.
- `&name;` never converts, so a server reference directly followed by a semicolon stays literal; add a space or other punctuation. Refusing every `;` is simpler and more predictable than matching the HTML5 named-entity list. The lookahead is a stopgap: Prose Spans from `@ian-pascoe/pi-utils/prose-references` include entity source as text, and if they stop doing so, the lookahead can go.
