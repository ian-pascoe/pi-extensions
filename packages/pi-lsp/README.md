# @ian-pascoe/pi-lsp

Language-server tools, managed defaults, and post-edit diagnostics for
[Pi](https://github.com/earendil-works/pi).

## Install

```bash
pi install npm:@ian-pascoe/pi-lsp
# or
pi install git:github.com/ian-pascoe/pi-extensions
```

For a local checkout, run `pi -e ./packages/pi-lsp/src/index.ts`.

No language manager or separate server installation is required for these built-in presets:

| Preset ID       | Files                                    | Server                                  | Workspace markers                                          |
| --------------- | ---------------------------------------- | --------------------------------------- | ---------------------------------------------------------- |
| `typescript`    | TS/JS, including JSX and module variants | TypeScript 7 native `tsc --lsp --stdio` | `tsconfig.json`, `jsconfig.json`, `package.json`, `.git`   |
| `pyright`       | `.py`, `.pyi`                            | Pyright                                 | `pyrightconfig.json`, `pyproject.toml`, `setup.py`, `.git` |
| `gopls`         | `.go`, `go.mod`, `go.work`               | gopls                                   | `go.work`, `go.mod`, `.git`                                |
| `rust-analyzer` | `.rs`                                    | rust-analyzer                           | `Cargo.toml`, `.git`                                       |

The nearest marker selects the workspace root; otherwise Pi's working directory is used.
Explicit matching Server Definitions suppress **all** built-in fallbacks for those files, even
under different IDs, and retain explicit multi-server behavior. Their Activation Gates and
Disabled state do not grant permission to substitute a default. Same-ID null or invalid definitions
also shadow a preset. Explicit failing commands are never silently replaced.

For presets, project-local executables precede PATH executables, then Managed Installations.
Server and supporting runtime selection are independent. Project candidates include ancestor
`node_modules/.bin` and the root's `bin`, `.bin`, `.venv/bin`, `.venv/Scripts`, `.cargo/bin`, and
`.go/bin`. A TypeScript 6 `tsc` is not a native LSP candidate. Pi LSP does not use
`typescript-language-server` or the removed `tsserver.js` API.

### Managed installations

The first actual LSP operation or applicable Post-edit Diagnostics waits for missing tools and
prerequisites, with progress. Nothing is downloaded on startup, discovery, or `status`. Node,
Go, or Rust prerequisites are acquired privately when needed; gopls acquisition also needs a
private Go compiler even when the running server will prefer an external Go toolchain.

All projects, worktrees, and Pi processes share `<Pi agent directory>/managed-tools` (normally
`~/.pi/agent/managed-tools`). The bundled installer provisions private mise automatically, stages
installations, and coordinates concurrent processes. Only child-process environments change:
user PATH, shell files, project dependencies, and external tool versions are untouched.

First installation and explicit Tool Updates select latest upstream and record concrete versions.
Existing versions are reused without registry refresh until updated. Native x64 and ARM64 Linux,
macOS, and Windows acquisition/launch baselines are documented in the
[shared installer](../pi-tool-installer/README.md#initial-verified-baselines); that native evidence
is separate from offline extension lifecycle tests.

Set `lsp.autoInstall` to `false` for **Installed-only Mode**:

```json
{ "lsp": { "autoInstall": false } }
```

It defaults to `true`; trusted project values override global values. Existing external and managed
installations still work. Missing tools report unavailability without downloading even the helper.
Explicit `/lsp update` remains a deliberate network action, so this is not a network sandbox.

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
/lsp update
/lsp update typescript
/lsp update cancel
```

- **Stop** ends one known Server Instance and clears its failure state. The next matching request
  can start it again. Omit the root when only one is known; otherwise choose a root in the picker
  or supply its path, relative to Pi's working directory or absolute.
- **Disable** prevents automatic and explicit startup of the entire Server Definition, stops all
  its Instances in this session, and clears their failed runtime state.
- **Enable** permits lazy startup without launching a process.
- **Update** advances only already installed managed presets (optionally one preset ID), reporting
  old/new versions, no change, or failure per tool. It never installs unused presets or modifies
  External Installations. Failed or cancelled updates retain the working selection. Running
  Server Instances keep their original executables; Stop followed by lazy startup, `restart`,
  or `/reload` selects the new version.
- During a Tool Update, press **Escape** in the TUI loader. RPC clients can send another prompt
  containing `/lsp update cancel`; native RPC `abort` only cancels an active agent turn, not an
  idle slash command. RPC gets status notifications rather than a custom terminal component.
  Print/JSON mode reports progress to stderr and has no interactive cancellation UI; shutdown
  cancels pending work. Updates remain awaited until acquisition cleanup finishes.

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
choices to manage overrides. The existing agent-facing `lsp` tool remains available, but cannot
start a disabled server.

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
when another server fails. Automatic reads omit matching incapable servers and fail once if none
are capable; explicitly selecting an incapable server reports that the operation is unsupported. A
mutation may omit `server_id` only when exactly one matching capable server exists.

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
Files excluded by every matching server's Activation Gate or disable state are skipped silently.
First-use acquisition progress appears in native status UI (stderr in headless modes). Escape
cancels assistance through Pi's active-turn signal. Failed or cancelled assistance preserves the
already successful mutation result and reports unavailable diagnostics; it never schedules a
later detached diagnostic operation.

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
the process within the configured timeout. Reload and shutdown also abort pending acquisitions
and Tool Updates, await cleanup, and leave durable Managed Installations intact.

## Security

Trusted project settings can launch arbitrary local executables with all permissions of the Pi
process. Review settings and server binaries before trusting a project. Built-in acquisition uses
source-owned tool identities; package registries and release artifacts remain supply-chain inputs.
See the shared installer's integrity and isolation limits; concrete top-level versions do not make
transitive packages reproducible. Mutation manifests can be
blocked by another extension, but Pi LSP itself intentionally imposes no workspace path boundary.
