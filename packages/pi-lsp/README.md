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

Every field is optional except an enabled server's non-empty `command` and `languages`. Each
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

Pi's `/reload` reloads configuration. Servers start on first use, live for one Pi session, and stay
unavailable after a process or protocol failure until `restart` or `/reload`.

## `lsp` tool

The extension registers one strict `lsp` tool with these operations:

```text
status                       capabilities                  restart
diagnostics                  workspace_diagnostics         completion
hover                        signature_help                declaration
goto_definition              goto_type_definition          goto_implementation
find_references              document_highlights           document_symbols
workspace_symbols            document_links                call_hierarchy
incoming_calls               outgoing_calls                type_hierarchy
supertypes                   subtypes                      selection_ranges
folding_ranges               code_lenses                   inlay_hints
document_colors              format_document               format_range
format_on_type               prepare_rename                rename
code_actions                 apply
```

File operations use `file_path`. Position operations also use one-based `line` and `character`;
characters count Unicode code points, regardless of the server's negotiated UTF-8, UTF-16, or
UTF-32 encoding. `selection_ranges` accepts a `positions` array. `find_references` accepts
`include_declaration`.

`workspace_symbols` requires `query` and a root-anchor `file_path`. `workspace_diagnostics`,
`capabilities`, and `restart` require `server_id` and a root-anchor `file_path`. Other reads query
every matching capable server unless narrowed by `server_id`; successful responses remain visible
when another server fails. A mutation may omit `server_id` only when exactly one matching capable
server exists.

Formatting requires `tab_size` and `insert_spaces`. It optionally accepts
`trim_trailing_whitespace`, `insert_final_newline`, and `trim_final_newlines`. Range formatting also
requires `start` and `end`; on-type formatting requires a position and `trigger_character`.
`rename` requires `new_name`. `code_actions` accepts a range and optional `only_kinds` filters.

Workspace diagnostics use protocol workspace pull when available and cached push diagnostics
otherwise. They never crawl the project to open files. Non-file result URIs such as `jar:` remain
readable.

In Pi's interactive transcript, each LSP call stays compact until tool output is expanded. The
collapsed row shows the operation, target, and outcome; the expanded row adds structured server or
mutation details followed by the exact tool output. Rendering uses Pi's active theme and native
tool-output expansion controls.

## Workspace Edit Preview and apply

`rename`, formatting, and edit-bearing code actions return a persisted Workspace Edit Preview.
They never write immediately. Command-bearing code actions remain visible but cannot be applied.
Server-initiated `workspace/applyEdit` requests are rejected with `applied: false` and exposed as a
preview in the active tool result.

Apply a preview with `{ "operation": "apply", "preview_id": "..." }`. Before Pi's `tool_call`
hooks run, `prepareArguments()` replaces any supplied `mutation_manifest` with canonical absolute
entries shaped as:

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
crash-atomic. A recovery failure reports every unrecovered path.

## Post-edit Diagnostics

Pi LSP appends fresh diagnostics to results from:

- any `edit` or `write` tool whose input has a string `path`;
- `apply_patch` results using the current `pi-codex-conversion` success/partial-result details;
- successful or partially applied LSP previews.

Changed, created, and renamed destination files are diagnosed; deleted files are not. Every
recognized result gets an explicit outcome, including `no diagnostics`, `no configured server`,
timeout, unavailable server, or an `apply_patch` adapter-version warning. Diagnostics preserve
duplicates from independent servers and never change the original tool's success or error state.
Only servers that advertise document diagnostics participate; formatting-only servers remain
available for explicit LSP formatting operations without appearing in Post-edit Diagnostics.
Files excluded by every matching server's Activation Gate are skipped silently.

Findings, matched-server failures, timeouts, and adapter warnings also appear in one expandable
Post-edit Diagnostics Entry after the current tool batch. Clean results and files without a
configured server stay silent in the transcript. This entry is excluded from model context; the
model sees diagnostics only in the original mutation result.

## Limits and lifecycle

Every operation uses Pi's 2,000-line/50-KB output limit. Complete truncated text is saved as a
Result Spill and the result names its path. Each server's latest 1 MB of stderr is saved in the
session temp directory and failure messages name that path.

Documents must be valid UTF-8. Each server keeps at most 100 synchronized documents and closes
least-recently-used documents. Session shutdown requests a graceful LSP shutdown, then terminates
the process within the configured timeout.

## Security

Trusted project settings can launch arbitrary local executables with all permissions of the Pi
process. Review settings and server binaries before trusting a project. Mutation manifests can be
blocked by another extension, but Pi LSP itself intentionally imposes no workspace path boundary.
