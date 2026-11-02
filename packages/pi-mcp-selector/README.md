# Pi MCP Selector

Point the model at MCP servers with `@server-name` anywhere in a user message.
Type `@` to open Pi's native completion popup: your MCP servers are listed first,
then the usual file results. Selecting a server leaves shorthand in the editor.
Repeat to reference several servers.

```bash
pi install npm:@ian-pascoe/pi-mcp-selector
```

Requires Pi `>=1.1.0` and Node `>=22.19.0`. There are no settings or extra tools.
Prose Span detection comes from
[`@ian-pascoe/pi-utils/prose-references`](../pi-utils/README.md#prose-references).

## Submission

Typed, pasted, and selected references are equivalent. On submission:

```text
Check open issues with @github.
→ Check open issues with [@github](mcp://github "MCP server mcp__github").
```

The link target is the configured server name and its title is the namespace
Pi gives the server's tools. The model receives a link, not instructions or tool
definitions, and chooses what to do with it. A reference only points: it does
not connect, load, or expose anything, and it leaves tool exposure, the system
prompt, and tool declarations unchanged. The submitted transcript stores the link
rather than a separate raw shorthand message.

Only exact known names in prose convert. Names are case-sensitive, and `-` and
`_` are interchangeable, as they are in Pi's tool names (`@dev_radius` reaches
`dev-radius`). These stay literal:

- partial or unknown names, `foo@github`, `@@github`, and `\@github`
- anything shaped like a path, address, or URI: `@github/x`, `@github.com`,
  `@./github`, and `@github:resource` (a colon not followed by a space)
- code, existing Markdown links, and HTML

Sentence punctuation does not block a reference: `@github's`, `(@github)`,
`@github.`, and `@github: list issues` all convert. Reuse of existing links
is safe, so submitting converted text again changes nothing.

## The MCP Server Catalogue

Both the popup and conversion read Pi's current tools, fresh on every popup and
every submission. A server is in the catalogue when it is enabled, connected, and
has at least one tool that is not `hidden`, whether it comes from `mcp.json` or an
extension's `registerMcpServer()`. Its exposure (`codemode`, `deferred`, `direct`)
does not matter, and neither does whether `codemode` is active.

- A disabled server re-registers its tools as hidden, so it is absent.
- A server that is still connecting or needs sign-in has no tools yet, so it is
  absent and its `@name` stays literal, silently. In `pi -p`, the first prompt's
  reference usually stays literal while servers connect.
- The popup describes each server as `MCP server · <description>`, using the
  configured `description` or the first line of the server's instructions, or just
  `MCP server` without either.

## Sharing `@` with file paths

Pi's native `@` completion lists files. Both appear in one popup, built here
over whatever provider is already installed:

- `@` alone lists every server by name, then the native files.
- `@git` lists servers whose name contains `git` (case-insensitive, names that
  start with it first), then the native files.
- The popup only merges for an unquoted `@name` in prose while at least one server
  is in the catalogue; otherwise native completion runs untouched. Servers are
  listed only when they match the query, but a file named like a server is always
  inserted as `@./name`, even for a fuzzy query such as `@ghb` that matches no
  server, so selecting a file never produces a server link.

If file search fails or finds nothing, the servers are still listed. Pi does not
expand `@path` in submitted messages, so only the popup and the literal text are
shared. See [ADR 0001](docs/adr/0001-share-at-with-file-mentions.md) for why `@`.

## Integration

Completion stacks over the current provider, retaining slash and file completion,
keyboard controls, and custom editors. It runs in the interactive terminal only.
Conversion applies to interactive, RPC, and print input, including steering and
follow-ups, without changing attachments or message routing. Extension-generated
input is unchanged. Direct RPC `steer` and `follow_up` commands run Pi's input hooks
too.

## Troubleshooting

- **No server in the popup:** open `/mcp` and check the server is enabled and
  connected, and has a tool that is not hidden. A server that needs sign-in or is
  still connecting is not listed.
- **No link:** check the exact case-sensitive name (`-` and `_` match either way),
  and whether the reference is escaped, in code, inside a link, or followed by `/`,
  `.name`, or `:text`.
- **File popup missing:** a quoted `@"…` or a path such as `@src/` uses Pi's native
  completion by design.
- **Pi older than 1.2.0:** servers are named after their namespace (`dev_radius`),
  not the configured name; `-` and `_` still match either way.
- **The model did not use the server:** inspect the submitted user message first.
  A correct link verifies conversion; using the server is the model's choice.
