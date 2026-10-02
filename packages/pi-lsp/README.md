# @ian-pascoe/pi-lsp

Configured language-server tools and post-edit diagnostics for
[Pi](https://github.com/earendil-works/pi).

## Install

```bash
pi install npm:@ian-pascoe/pi-lsp
# or
pi install git:github.com/ian-pascoe/pi-extensions
```

For a local checkout, run `pi -e ./packages/pi-lsp/src/index.ts`.

Install every language-server executable separately. Pi LSP contains no server catalog or
installer. It launches configured commands over stdio with the Pi process's environment and
permissions.

## Settings

Pi LSP reads only the `lsp` key from Pi's global `settings.json` and trusted project
`.pi/settings.json`:

```json
{
  "lsp": {
    "timeouts": {
      "initializeMs": 45000,
      "requestMs": 3000,
      "diagnosticsMs": 3000,
      "shutdownMs": 5000
    },
    "servers": {
      "typescript": {
        "command": "pnpm",
        "args": ["exec", "tsc", "--lsp", "--stdio"],
        "languages": [
          {
            "extensions": [".ts", ".mts", ".cts"],
            "languageId": "typescript"
          },
          {
            "extensions": [".tsx"],
            "languageId": "typescriptreact"
          }
        ],
        "requireRootMarker": true,
        "rootMarkers": ["tsconfig.json", "package.json", ".git"],
        "initializationOptions": {},
        "settings": {},
        "environment": {}
      }
    }
  }
}
```

Every field is optional except a Server Definition's non-empty `command` and `languages`, even
when that definition is disabled. Each
language needs a non-empty `languageId` and at least one extension or exact filename. Extensions
include their leading period. `rootMarkers` are basename glob patterns; the nearest matching
ancestor becomes the server root and Pi's working directory is the fallback. Set
`requireRootMarker` to `true` to exclude the server for files without any matching ancestor; it
defaults to `false`. A required empty `rootMarkers` list is invalid. Explicit requests naming an
otherwise compatible excluded server report that its required root marker was not found.

Global and project timeouts merge by field. A project server replaces the complete global server
with the same ID; set a project server to `null` to remove it. `initializationOptions` is sent only
during initialization. `settings` is used for `workspace/didChangeConfiguration` and
`workspace/configuration`. Environment strings override `process.env`; `null` removes a variable.
Invalid server definitions and timeout fields are quarantined individually and remain visible
through `status`; unrelated valid settings continue to work. An invalid project server replacement
still shadows the global definition. Untrusted project settings are ignored.

Pi's `/reload` reloads configuration. Servers start lazily on first use and live for one Pi session.
After a process or protocol failure, recovery requires stopping the affected Instance, disabling
then enabling its Definition, using the existing `restart` tool operation, or `/reload`.

## `/lsp` command

Use `/lsp` to inspect server status and choose an action. The picker displays known workspace
roots and the effective enablement scope; opening it never starts a server. Text shortcuts are:

```text
/lsp stop typescript
/lsp stop typescript "packages/my app"
/lsp disable typescript
/lsp enable typescript
/lsp disable typescript --project
/lsp enable typescript --global
```

- **Stop** ends one known Server Instance and clears its failure state. The next matching request
  can start it again. Omit the root when only one is known; otherwise choose a root in the picker
  or supply its path, relative to Pi's working directory or absolute.
- **Disable** prevents automatic and explicit startup of the entire Server Definition, stops all
  its Instances in this session, and clears their failed runtime state.
- **Enable** permits lazy startup without launching a process.

Unflagged enable/disable choices are custom session entries. They survive `/reload` and saved-session
resume, but follow the selected branch: navigating before a choice rolls it back, and forks inherit
choices on their selected ancestry. A newly created session starts without session overrides. Pi
only flushes entries in a brand-new session after its first assistant message; ephemeral sessions
are not persisted.

`--project` and `--global` write only the chosen settings document's `lsp.enablement` map, preserving
Server Definitions and unrelated settings. Project writes require a trusted project. For example,
this project setting disables an inherited global Definition without copying it:

```json
{ "lsp": { "enablement": { "typescript": false } } }
```

Enablement resolves independently of Server Definition replacement, by server ID:
**session override → project setting → global setting → enabled by default**. Explicit `true`
can override a lower scope's `false`. Scoped commands do not change session overrides and report
when a higher-priority choice masks their effect. They update eligibility immediately in the current
session; other sessions read the settings on startup or `/reload`. Changes to commands, languages,
and other definition fields still require `/reload`.

There are no `/lsp start`, `/lsp restart`, or `/lsp inherit` subcommands. Use explicit enable/disable
choices to manage overrides. The agent-facing LSP tools remain available, but cannot start a
disabled server.

## LSP tools

The extension registers one Pi tool per operation, named `lsp_<operation>` and grouped under the
`lsp` tool namespace. Each tool's parameters contain only that operation's fields. The core tools
are declared to the model; the others use Pi's `codemode` exposure:

| Exposure                     | Tools                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Declared (`direct`)          | `lsp_diagnostics`, `lsp_hover`, `lsp_goto_definition`, `lsp_find_references`, `lsp_document_symbols`, `lsp_workspace_symbols`, `lsp_rename`, `lsp_code_actions`, `lsp_apply`                                                                                                                                                                                                                                                                                                                                                                                                |
| Script-callable (`codemode`) | `lsp_status`, `lsp_capabilities`, `lsp_restart`, `lsp_workspace_diagnostics`, `lsp_completion`, `lsp_signature_help`, `lsp_declaration`, `lsp_goto_type_definition`, `lsp_goto_implementation`, `lsp_document_highlights`, `lsp_document_links`, `lsp_call_hierarchy`, `lsp_incoming_calls`, `lsp_outgoing_calls`, `lsp_type_hierarchy`, `lsp_supertypes`, `lsp_subtypes`, `lsp_selection_ranges`, `lsp_folding_ranges`, `lsp_code_lenses`, `lsp_inlay_hints`, `lsp_document_colors`, `lsp_format_document`, `lsp_format_range`, `lsp_format_on_type`, `lsp_prepare_rename` |

Script-callable tools are not declared to the model. They are reachable in three ways:

- With Pi's `codemode` tool active, scripts call them as `tools.lsp_status({})`, and the `codemode`
  description lists them with their declarations under the `lsp` namespace.
- With Pi's `tool_search` tool active, the model can find one and declare it for later turns.
- Any tool can be declared by name, like other inactive extension tools: add it to `defaultTools`
  (for example `"defaultTools": ["+lsp_workspace_diagnostics"]`) or name it in `--tools`.

`codemode` and `tool_search` are off by default; enable them with `"defaultTools": ["+codemode"]`
or `["+tool_search"]`. Without one of them, only the declared tools are available unless you add
others by name.

File tools use `file_path`. Position tools also use one-based `line` and `character`; characters
count Unicode code points, regardless of the server's negotiated UTF-8, UTF-16, or UTF-32
encoding. Paths may start with `@`. `lsp_selection_ranges` accepts a `positions` array.
`lsp_find_references` accepts `include_declaration` (default `true`).

`lsp_workspace_symbols` requires `query` and a root-anchor `file_path`. `lsp_workspace_diagnostics`,
`lsp_capabilities`, and `lsp_restart` require `server_id` and a root-anchor `file_path`. Other reads
query every matching capable server unless narrowed by `server_id`; successful responses remain
visible when another server fails. Automatic reads omit matching incapable servers and fail once if
none are capable; explicitly selecting an incapable server reports that the operation is
unsupported. A mutation may omit `server_id` only when exactly one matching capable server exists.

Formatting requires `tab_size` and `insert_spaces`. It optionally accepts
`trim_trailing_whitespace`, `insert_final_newline`, and `trim_final_newlines`. Range formatting also
requires a `range`; on-type formatting requires a position and `trigger_character`. `lsp_rename`
requires `new_name`. `lsp_code_actions` accepts a range and optional `only_kinds` filters.

The shared rules reach the model as one system-prompt guideline, which Pi adds once while any LSP
tool is declared. On Pi 1.0.0 and later, scripts can also read them with
`describeNamespace("lsp")`.

### Migrating from the single `lsp` tool

Releases before 0.5.0 registered one `lsp` tool with an `operation` argument. It was removed
without an alias:

- Call `lsp_<operation>` with the same arguments minus `operation`: `{"operation":"hover", ...}`
  becomes `lsp_hover` with `{ ... }`, and `{"operation":"apply","preview_id":"..."}` becomes
  `lsp_apply` with `{"preview_id":"..."}`.
- Settings that grant or select `lsp` by exact name, such as `defaultTools`, `--tools`, Advisor
  `allowedTools`, or Minimal Subagents toolsets, must name the new tools instead.
- Tools outside the declared core need `codemode` or `tool_search`, or must be named in
  `defaultTools` or `--tools`.
- `lsp_status` reports `server_id` and `root_path` instead of `serverId` and `rootPath`.
- Resumed sessions keep their Workspace Edit Previews from `lsp` results; apply them with
  `lsp_apply`.

### Tool annotations

Each tool carries MCP-style annotations that permission extensions can read from
`pi.getAllTools()`. Pi does not send them to model providers.

| Tools                                                        | `readOnlyHint` | `destructiveHint` | `idempotentHint` | `openWorldHint` |
| ------------------------------------------------------------ | -------------- | ----------------- | ---------------- | --------------- |
| Queries, `lsp_status`, `lsp_capabilities`, and preview tools | `true`         | `false`           | `true`           | `false`         |
| `lsp_restart`                                                | `false`        | `false`           | `true`           | `false`         |
| `lsp_apply`                                                  | `false`        | `true`            | `false`          | `false`         |

`lsp_rename`, `lsp_code_actions`, and the `lsp_format_*` tools are read-only: they only record a
session-local Workspace Edit Preview. Files change only through `lsp_apply`.

### Structured results

Every tool declares an output schema and returns matching `structuredContent`, which codemode
scripts receive instead of the text. Reads resolve to
`{ results: { server_id, root_path, value }[], warnings, truncated, spill_path? }`, where `value` is
the server's response with one-based positions and file paths instead of `file:` URIs.
`lsp_status`, `lsp_capabilities`/`lsp_restart`, the preview tools, `lsp_code_actions`, and
`lsp_apply` have their own shapes; `describeTool(name)` shows each declaration.

Structured results are always complete. Pi keeps them out of model context and session history, so
the model-facing output limit does not cut them: `truncated` reports that the text the model saw was
cut, and `spill_path` names the Result Spill with the complete text. Server-initiated previews
reported with a result appear in `server_preview_ids`.

Workspace diagnostics use protocol workspace pull when available and cached push diagnostics
otherwise. They never crawl the project to open files. Non-file result URIs such as `jar:` remain
readable.

In Pi's interactive transcript, each LSP call stays compact until tool output is expanded. The
collapsed row shows the operation, target, and outcome; the expanded row adds structured server or
mutation details followed by the exact tool output. Rendering uses Pi's active theme and native
tool-output expansion controls.

## Workspace Edit Preview and apply

`lsp_rename`, the `lsp_format_*` tools, and edit-bearing code actions return a persisted Workspace
Edit Preview. They never write immediately. Command-bearing code actions remain visible but cannot
be applied. Server-initiated `workspace/applyEdit` requests are rejected with `applied: false` and
exposed as a preview in the active tool result.

Apply a preview with `lsp_apply` and `{ "preview_id": "..." }`. `lsp_apply` is always declared, so
every preview can be applied, including previews recorded by the removed `lsp` tool in a resumed
session. Before Pi's `tool_call` hooks run, `prepareArguments()` replaces any supplied
`mutation_manifest` with canonical absolute entries shaped as:

```json
{
  "mutation_manifest": [
    {
      "operation": "modify",
      "path": "/absolute/canonical/content/target"
    },
    {
      "operation": "rename",
      "path": "/absolute/old/name",
      "destination_path": "/absolute/new/name"
    }
  ]
}
```

`operation` is `create`, `modify`, `delete`, or `rename`; only rename also has
`destination_path`. A permission extension may inspect or
block this manifest. Pi LSP validates it again after all hooks, then rechecks preview state,
existence, hashes, modes, and destinations inside Pi's sorted per-file mutation queues. Paths are
not restricted to the workspace.

Application uses temporary-file replacement, preserves modes and UTF-8 BOMs, and keeps originals
for reverse rollback. Content edits follow existing symlinks and expose the canonical target;
rename and delete address the named directory entry. The guarded batch is rollback-capable, not
crash-atomic. A recovery failure is an error result whose `changed_paths` lists every unrecovered
path; codemode scripts still receive its structured result, with `state: "partial_failure"`.

## Post-edit Diagnostics

Pi LSP appends fresh diagnostics to results from:

- any `edit` or `write` tool whose input has a string `path`;
- `apply_patch` results using the current `pi-codex-conversion` success/partial-result details;
- successful or partially applied LSP previews from `lsp_apply`, and from the removed `lsp` tool.

Changed, created, and renamed destination files are diagnosed; deleted files are not. Every
recognized result gets an explicit outcome, including `no diagnostics`, `no configured server`,
timeout, unavailable server, or an `apply_patch` adapter-version warning. Diagnostics preserve
duplicates from independent servers and never change the original tool's success or error state.
Only servers that advertise document diagnostics participate; formatting-only servers remain
available for explicit LSP formatting operations without appearing in Post-edit Diagnostics.
Files excluded by every matching server's Activation Gate or disable state are skipped silently.

Findings, matched-server failures, timeouts, and adapter warnings also appear in one expandable
Post-edit Diagnostics Entry after the current tool batch. Its collapsed rendering shows the summary
and a prefix of the same details, capped at eight rendered rows; expanding it shows every detail.
Clean results and files without a configured server stay silent in the transcript. This entry is
excluded from model context; the model sees diagnostics only in the original mutation result.

## Limits and lifecycle

Every LSP tool uses Pi's 2,000-line/50-KB output limit for model-visible text. Complete truncated text is saved as a
Result Spill and the result names its path. Each server's latest 1 MB of stderr is saved in the
session temp directory and failure messages name that path. With `--no-session`, Pi provides no
session directory, so these files use a private directory under the OS temporary directory instead.
Normal session teardown removes it; forced termination may leave temporary files behind.

Documents must be valid UTF-8. Each server keeps at most 100 synchronized documents and closes
least-recently-used documents. Session shutdown requests a graceful LSP shutdown, then terminates
the process within the configured timeout.

## Security

Trusted project settings can launch arbitrary local executables with all permissions of the Pi
process. Review settings and server binaries before trusting a project. Mutation manifests can be
blocked by another extension, but Pi LSP itself intentionally imposes no workspace path boundary.
