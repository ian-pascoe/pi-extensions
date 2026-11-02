# Pi MCP Selector

Point the model at MCP servers with `&server-name` anywhere in a user message.
Type `&` to open a completion popup listing your MCP servers. Selecting a server
leaves shorthand in the editor. Repeat to reference several servers. `@` stays
Pi's file completion and is not used.

```bash
pi install npm:@ian-pascoe/pi-mcp-selector
```

Requires Pi `>=1.1.0` and Node `>=22.19.0`. There are no settings or extra tools.
Prose Span detection and the completion popup stack come from
[`@ian-pascoe/pi-utils/prose-references`](../pi-utils/README.md#prose-references).

## Submission

Typed, pasted, and selected references are equivalent. On submission:

```text
Check open issues with &github.
→ Check open issues with [&github](mcp://github "MCP server mcp__github").
```

The link target is the configured server name and its title is the namespace
Pi gives the server's tools. The model receives a link, not instructions or tool
definitions, and chooses what to do with it. A reference only points: it does
not connect, load, or expose anything, and it leaves tool exposure, the system
prompt, and tool declarations unchanged. The submitted transcript stores the link
rather than a separate raw shorthand message.

Only exact known names in prose convert. Names are case-sensitive, and `-` and
`_` are interchangeable, as they are in Pi's tool names (`&dev_radius` reaches
`dev-radius`). These stay literal:

- partial or unknown names, `foo&github`, `&&github`, and `\&github`
- text that merely contains an ampersand: `R&D`, `Q&A`, `a && b`, `Q & A`, and
  Rust's `&self` or `&str` when no server has that name
- HTML entities, even when a server has the entity's name: `&amp;`, `&nbsp;`, and
  `&amp;github` stay literal for servers named `amp` or `nbsp` (a name directly
  followed by `;` never converts)
- anything shaped like a path, address, or URI: `&github/x`, `&github.com`,
  `&./github`, and `&github:resource` (a colon not followed by a space)
- code, existing Markdown links, and HTML

Sentence punctuation does not block a reference: `&github's`, `(&github)`,
`&github.`, and `&github: list issues` all convert. Reuse of existing links
is safe, so submitting converted text again changes nothing.

## The MCP Server Catalogue

Both the popup and conversion read Pi's current tools, fresh on every popup and
every submission. A server is in the Catalogue when it is enabled, connected, and
has at least one tool that is not `hidden`, whether it comes from `mcp.json` or an
extension's `registerMcpServer()`. Its exposure (`codemode`, `deferred`, `direct`)
does not matter, and neither does whether `codemode` is active.

- A disabled server re-registers its tools as hidden, so it is absent.
- A server that is still connecting or needs sign-in has no tools yet, so it is
  absent and its `&name` stays literal, silently. In `pi -p`, the first prompt's
  reference usually stays literal while servers connect.
- The popup describes each server as `MCP server · <description>`, using the
  configured `description` or the first line of the server's instructions
  (without Markdown heading markers such as `# `), or just `MCP server`
  without either.

## Completion popup

`&` has its own popup, like `$skill` and `#123` in the sibling selectors:

- `&` after a space or other token boundary, or alone at the start of a line, lists
  every server by name.
- `&git` lists servers whose name contains `git` (case-insensitive, names that
  start with it first).
- The popup appears only for an unquoted `&name` in prose, and only when a server
  matches. `&` is plain text in Markdown, so a lone `&` at the start of a line
  opens the popup too. An HTML entity such as `&amp;` is complete as written, so
  it never opens or converts to a server reference.

Pi's editor opens the popup by itself only for `@`, `#`, and the characters the
outermost autocomplete provider lists in `triggerCharacters`. If another extension
wraps the provider without forwarding `triggerCharacters` (`@ff-labs/pi-fff` 0.11.0
does not), press Tab after `&` to open it. See
[ADR 0002](docs/adr/0002-reference-servers-with-ampersand.md) for why `&` and not `@`, `+`, or `$`.

## Integration

Completion stacks over the current provider, retaining slash and `@` file completion,
keyboard controls, and custom editors. It runs in the interactive terminal only.
Conversion applies to interactive, RPC, and print input, including steering and
follow-ups, without changing attachments or message routing. Extension-generated
input is unchanged. Direct RPC `steer` and `follow_up` commands run Pi's input hooks
too.

## Troubleshooting

- **No server in the popup:** type `&` after a space, then open `/mcp` and check the server is enabled and
  connected, and has a tool that is not hidden. A server that needs sign-in or is
  still connecting is not listed.
- **No link:** check the exact case-sensitive name (`-` and `_` match either way),
  and whether the reference is escaped, in code, inside a link, or followed by `/`,
  `.name`, `:text`, or `;` (an HTML entity).
- **`&` opens nothing:** press Tab after `&` (see Completion popup), and check the
  server is in the Catalogue.
- **Pi older than 1.2.0:** servers are named after their namespace (`dev_radius`),
  not the configured name; `-` and `_` still match either way.
- **The model did not use the server:** inspect the submitted user message first.
  A correct link verifies conversion; using the server is the model's choice.
