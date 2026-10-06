# @ian-pascoe/pi-lsp

## 0.8.0

### Minor Changes

- 6bd6781: References and rename now open one file in each unloaded workspace package (up to 20 packages, 10 seconds) in a workspace root before searching, so importers in packages not opened before are found, and only packages still unloaded are warned about.
- b33e696: Structured results add flat one-based `path`, `line`, and `character` to locations and symbols, and `kind_name` to symbols, and structured `lsp_status` now lists only the servers its text lists, reporting the rest as `not_started`, unless `all: true`.

### Patch Changes

- 7a86863: Post-edit Diagnostics no longer list a file as "no diagnostics" when another server reported a finding for it.

## 0.7.0

### Minor Changes

- d76f5bd: `lsp_diagnostics`, `lsp_workspace_diagnostics`, `lsp_hover`, `lsp_status`, `lsp_code_actions`, and `lsp_apply` now show the model compact text (such as one `path:line:col severity source(code): message` line per diagnostic) instead of a JSON envelope, while scripts still receive the unchanged structured result.
- 4fbfa6c: `lsp_status` now lists only Server Instances and Disabled Server Definitions and counts the other configured Server Definitions; pass `all: true` to list every configured server.

### Patch Changes

- 70b3ebc: `lsp_find_references` and `lsp_rename` now report other workspace roots and unloaded packages as one compact line with counts, at most three names, and the troubleshooting Skill path.
- fad9d49: Post-edit Diagnostics no longer add a "not checked (no configured server)" line: files no Server Definition covers stay silent, and no diagnostics section is appended when none of the edited files is covered, while a failure or timeout from a covering Server Definition's Server Instance is still reported.

## 0.6.0

### Minor Changes

- 91c12ed: `lsp_completion` and `lsp_workspace_symbols` return a bounded, relevant list. Both accept `limit` (default 50 items per server) and report how many more items matched. `lsp_completion` accepts `prefix`, which defaults to the identifier before the position, and orders matches by the server's sort text. Only kept items are resolved. The model sees one `label (kind)  detail` line per completion, matching the `name (kind)` symbol format, without server-private resolve `data`. Workspace symbols keep the shared symbol format and gain the omitted count. Structured Results hold the bounded response plus `prefix` and `omitted`.
- 5500673: `lsp_code_actions` no longer loses a server's other actions when one action's edit fails Workspace Edit Preview validation, such as an edit that targets a missing file. That action is listed with `applicable: false` and an `error` explaining why, the server's other actions and their previews are returned as usual, and the server is no longer reported as a failed request. The structured result adds the optional `error` field on actions.
- c3ccf2e: Position-based query results now echo the token at the requested position, so off-by-one positions are visible. Results start with `Query position: src/a.ts:1:14 ("value")`, or show the trimmed line when the position is on whitespace or past the line end. When no server found anything, the result says so for that position, such as `No call hierarchy item at src/todo.ts:61:18 ("readonly").` or `No completions start with "r" at …`; the hierarchy follow-ups tell a position without a hierarchy item apart from an item without calls or types. Structured Results of position tools add `position: { path, line, character, token?, line_text }`. `lsp_hover`, `lsp_signature_help`, and `lsp_prepare_rename` put this line before their JSON, and their result rows count results.
- 1b3f41d: Location results read as compact text. `lsp_find_references`, the goto tools, `lsp_declaration`, and `lsp_document_highlights` now show the model one `path:line:col  <source line>` line per location, with paths relative to the working directory and named highlight kinds (`read`, `write`, `text`). Results are grouped by server only when several servers answered. Structured Results for codemode scripts are unchanged, and the tool guidance states that result positions are one-based.
- 298c669: Post-edit Diagnostics read as compact text. Findings are one `path:line:col severity [server]: message` line each, with paths relative to the working directory, named severities (`error`, `warning`, `info`, `hint`) instead of `severity 1`, and the full message collapsed onto one line. When every changed file is clean, the section is the single line `LSP diagnostics: no diagnostics`; otherwise clean files share one `no diagnostics: a.ts, b.ts` line. Files with no configured server share one `not checked (no configured server): README.md, package.json` line. That now includes a file whose language a server handles but whose required root marker is missing; before, such a file produced no output, which looked the same as a clean result. A file whose matching servers you disabled stays silent.
- fdce903: Symbol, hierarchy, and range results read as compact text. Document and workspace symbols show the model an indented outline of `name (kind) path:line:col` lines with named symbol kinds (`class`, `function`, `variable`, …) instead of numbers; call and type hierarchies list `name (kind) path:line:col` items with incoming and outgoing call sites as `path:line:col  <source line>`; selection ranges are a flat innermost-to-outermost list; and folding ranges read `startLine-endLine kind  <first source line>`. Paths are relative to the working directory. Structured Results for codemode scripts are unchanged.

  Outgoing call sites are now converted against the file of the prepared call-hierarchy item rather than the queried file, so `lsp_outgoing_calls` at a call site whose declaration lives in another file no longer fails or reports wrong columns.

- 2fdfc49: `lsp_find_references` and `lsp_rename` now name the workspace root they searched. Each root gets its own server, so in a monorepo a rename could miss every importing package without saying so. When the same server has other roots, either running or found by root markers under the working directory, both tools warn that files outside the searched root may be missing. The rename warning starts the Workspace Edit Preview summary, so it is visible before `lsp_apply`. Preview structured results add `root_path` and `warnings`.
- 8971558: Several LSP results are now accurate:

  - `lsp_status` lists the languages of each Server Definition, as a map from language ID to the file extensions and filenames it handles, so you can tell which server will handle a file.
  - `lsp_workspace_diagnostics` no longer returns an empty `fresh` result for a server that answers only document pulls, such as the TypeScript server. For that server it returns `{ status: "unsupported", message }` with an `unsupported` server outcome (shown as "Unsupported" in the transcript), and the message points to `lsp_diagnostics`. Each file's `uri` is now a plain path instead of a `file:` URI, as in other LSP results.
  - `lsp_code_actions` without `server_id` lists the actions of every capable server, instead of failing with "provide server_id". Each action names its `server_id`, and failing servers appear in `warnings`. An explicit `server_id` still limits the request to that server. **Breaking for scripts:** the structured result no longer has a top-level `server_id`; read it from each action.
  - A Workspace Edit Preview whose edits change nothing, such as formatting an already-formatted file, reports `No changes` and an empty Mutation Manifest. Before, it reported the file as modified. Text edits that leave a file unchanged are left out of every Mutation Manifest.

- 80a932d: A server can now cover a whole monorepo with the new `workspaceRootMarkers` setting, such as `["pnpm-workspace.yaml"]` or `[".git"]`. The nearest ancestor that contains one of these markers becomes the server root, so files in every package share one server, and `lsp_find_references` and `lsp_rename` find and edit usages in other packages. Servers without the setting route exactly as before.

  The search never selects your home directory or anything above it unless Pi's working directory is there. Without a match, the nearest `rootMarkers` ancestor and then the working directory are used as before. `requireRootMarker` still checks only `rootMarkers`.

  Packages inside a workspace root are no longer reported as other workspace roots, so the "searched only its workspace root" warning no longer appears for them.

  A language server searches only the packages it has loaded, and Pi LSP never opens files to load them. In a workspace root, `lsp_find_references` and `lsp_rename` therefore warn about packages where the server has no open file yet, such as `typescript has not loaded files from packages/b under /work/repo; their references may be missing`, and suggest running any LSP tool on a file there before retrying.

### Patch Changes

- e0e3b46: `lsp_code_actions` now returns diagnostic-dependent quick fixes, such as adding a missing import. The request sends the selected server's current LSP Diagnostics that overlap the range instead of an empty list. It uses diagnostics the server already reported for the file's current contents, otherwise waits for fresh push or pull diagnostics within the diagnostics timeout. When diagnostics are unavailable, the code-action request still runs.
- 5500673: `lsp_code_actions` now applies `only_kinds` itself instead of trusting the server to filter. A requested kind matches itself and its dot-separated sub-kinds (`quickfix` matches `quickfix.import`, not `quickfixes`). Actions of other kinds, actions without a kind, and plain commands are dropped. Without `only_kinds`, every action is still returned.
- a2cebd8: When every server that handles a file's language is disabled, LSP tools now say so instead of reporting that no configured server matches. The error lists the disabled servers and how to enable one, for example `Pi LSP: all servers matching /repo/src/app.ts are disabled: typescript, eslint; enable one with /lsp enable <id>`. "No configured server matches" remains for files that no enabled server applies to, including one excluded by its required root marker. Disabled servers are still skipped without a warning when another matching server is enabled, and Post-edit Diagnostics stay silent for files whose servers are all disabled.
- f7e9eed: Fix `lsp_incoming_calls` for callers in other files. Each incoming call's `fromRanges` are now converted against the caller's file text instead of the requested file's, so they no longer fail with `protocol position character exceeds line length` or return wrong columns after non-ASCII text.
- dd38ba9: `lsp_find_references` and `lsp_rename` now warn about sibling workspace roots when Pi starts inside a package. Discovery of other roots of the same Server Definition starts from the outermost ancestor of the searched root that contains one of its root markers, instead of from Pi's working directory, so with Pi in `packages/a` the warning lists `packages/b` and the repository root before their servers have started. Discovery starts no higher than that directory, and never at your home directory or above it unless Pi's working directory is at or above it. It keeps its limits: it skips symbolic links, hidden directories, and `node_modules`, and checks at most 4,096 directories.
- b3c64e2: LSP tool errors now say what went wrong:

  - An unsupported operation names the protocol method it needs, such as `textDocument/declaration`, and lists the matching servers that lack it.
  - A missing file or a directory is rejected before any server is routed or started.
  - A position past the end of the document is reported as an input error, not as a failed server request, and the message gives the document's line count or the line's length.
  - A file that no server handles reads "no configured server matches <path>".
  - An unknown `server_id` reads "server <id> is not configured".

  The pointer to the troubleshooting Skill now appears only on server startup, crash, timeout, request, and configuration failures. Input errors and unsupported capabilities no longer show it.

- ab4e44e: `lsp_code_actions`, `lsp_rename`, and the `lsp_format_*` tools no longer leave Workspace Edit Previews behind that no result names. When a call fails after a preview was created, such as when a second server rejects the request's position or the full output cannot be written to a Result Spill, those previews are discarded and can no longer be applied. Server-initiated previews are kept for the next result after such a failure. Read tools and `lsp_code_actions` now wait for every queried server that already started its request to answer or fail before they fail, with the same error as before; a server that is still starting is not waited for.
- a2cebd8: `lsp_rename`, `lsp_format_document`, `lsp_format_range`, and `lsp_format_on_type` now report a server that times out or crashes, while synchronizing the document or answering the request, the way read tools and `lsp_code_actions` do: `Pi LSP: server <id> request failed: …`, followed by the pointer to the troubleshooting Skill. Before, the raw client error escaped without the server label or the pointer. A position past the end of the document is still an input error without the pointer. A cancelled request, such as an aborted tool call, now ends every LSP tool with the plain cancellation error, without a server label or the pointer.
- 298c669: `lsp_workspace_diagnostics` now says what a result from pushed diagnostics covers. When a server has no workspace pull, the result carries a `message` stating that the server publishes no workspace diagnostics, how many files opened in this session the pushed diagnostics cover (including files with none), and that `lsp_diagnostics` checks other files. An empty result can no longer be read as a clean workspace. Workspace pull results are unchanged.
- dd38ba9: LSP routing no longer lists a file's ancestor directories when none of the enabled servers that handle its language has root markers. Such servers use the working directory as their root, so each tool call and Post-edit Diagnostics skip the directory reads, which were slow for files under large directories such as a home or downloads folder. Routing is unchanged when a matching server has root markers.
- 483ae15: A file that changed on disk after the language server read it no longer fails that server's whole result. Before, one position past the end of such a file made `lsp_goto_definition` and the other location tools, `lsp_call_hierarchy`, `lsp_type_hierarchy`, `lsp_supertypes`, `lsp_subtypes`, `lsp_incoming_calls`, `lsp_outgoing_calls`, `lsp_workspace_symbols`, `lsp_workspace_diagnostics`, `lsp_diagnostics` (related information), and `lsp_inlay_hints` (label-part locations) fail with `line exceeds document length` or `character exceeds line length`. An end-of-line position in the queried file, such as `2147483647`, no longer fails tools such as `lsp_folding_ranges` and `lsp_hover` either.

  A character past the end of its line is now clamped to the line end, as the LSP specification says, without a warning. A line past the end of the file keeps the server's position (adding 1 to the line and character), and a position inside a Unicode character snaps to the start of that character. A warning names those files, because their positions may be wrong, and the server's other positions are unaffected.

- a2cebd8: LSP tools and Post-edit Diagnostics recognize a timed-out language-server request from the client's own timeout instead of searching the error text for "timed out". A server error whose message happens to contain "timed out" now appears in `server_outcomes` as `error`, not `timeout`, and in Post-edit Diagnostics as an unavailable server rather than a diagnostics timeout. A server whose startup timed out is reported as unavailable in Post-edit Diagnostics, as it already was in `server_outcomes`. Timeouts still point to the troubleshooting Skill.
- 42037c6: LSP results no longer convert a position against the wrong file's text. Before, a result naming a file without readable text, such as a `jdt://` or `deno:` URI, a file that failed to read, or invalid UTF-8, could fail that server's whole result with a position error or show wrong columns.

  Positions in such a file are now approximated by adding 1 to the line and character, and a warning names the file: lines are exact, but columns may be off after non-ASCII text. This covers `lsp_goto_definition` and the other location tools, `lsp_incoming_calls`, `lsp_outgoing_calls`, `lsp_workspace_symbols`, and `lsp_workspace_diagnostics`.

  `lsp_outgoing_calls` now shows call sites in a non-`file:` calling item under its URI instead of under the queried file, and `lsp_workspace_symbols` lists symbols in such files as symbol lines instead of JSON. Positions in the queried file use the text the server was synced with.

## 0.5.0

### Minor Changes

- 1c6bc03: **Breaking:** requires Pi 0.99.0 or later. The single `lsp` tool is replaced by one tool per operation, named `lsp_<operation>` (for example `lsp_hover` and `lsp_apply`) and grouped under the `lsp` namespace. Each tool takes only its own arguments, so `{"operation":"hover", ...}` becomes `lsp_hover` with the same fields minus `operation`. There is no alias for `lsp`.

  Ten tools are declared to the model: `lsp_status`, `lsp_diagnostics`, `lsp_hover`, `lsp_goto_definition`, `lsp_find_references`, `lsp_document_symbols`, `lsp_workspace_symbols`, `lsp_rename`, `lsp_code_actions`, and `lsp_apply`. The other operations, including `lsp_capabilities`, `lsp_restart`, and formatting, are callable from Pi's `codemode` scripts, which list them under the `lsp` namespace, and `tool_search` can load them. Both are off by default; without them, add a tool by name with `defaultTools` (for example `"+lsp_capabilities"`) or `--tools`.

  Migration:

  - Settings that grant or select `lsp` by exact name (`defaultTools`, `--tools`, Advisor `allowedTools`, Minimal Subagents toolsets) must name the new tools, for example the pattern `lsp_*` in a Minimal Subagents toolset.
  - `lsp_status` now reports `server_id` and `root_path` instead of `serverId` and `rootPath`.
  - Resumed sessions keep their Workspace Edit Previews from `lsp` results; apply them with `lsp_apply`.

  Each tool carries tool annotations for permission extensions: queries and preview tools are read-only (preview tools are not idempotent, since each call creates a new `preview_id`), `lsp_restart` is non-destructive, and `lsp_apply` is destructive. Every tool also declares an output schema, so `codemode` scripts receive structured results. A structured result is capped at 1 MiB, like Pi's built-in `bash` tool: a larger one is bounded (the longest strings and array tails are cut, and ids, paths, and enum values are kept) and reports `structured_truncated: true` and `truncated: true`, with `spill_path` naming a Result Spill that holds the complete structured data. `truncated` and `spill_path` are also set when only the model-visible text was cut; `structured_truncated` then stays `false`. `lsp_diagnostics` has a prompt snippet so the `lsp_*` tools appear in Pi's default system prompt. An `lsp_apply` partial failure is now an error result from the tool itself, and scripts still receive its structured result.

### Patch Changes

- 0ea1e75: Declare Pi `>=0.99.0` as the peer range for `@earendil-works/pi-coding-agent`, `pi-ai`, `pi-agent-core`, and `pi-tui`, replacing `*`. Installing against an older Pi now warns at install time instead of failing when a package uses an API that Pi release lacks. Pi Utils keeps its Pi peer optional.
- Updated dependencies [0ea1e75]
  - @ian-pascoe/pi-utils@0.3.1

## 0.4.7

### Patch Changes

- b15f4fd: Shutting down a language server no longer fails when its connection closed before its process exited. Post-edit diagnostics and other file routing no longer list every ancestor directory for files no configured server handles, which made large batches of edits slow in big directories.

## 0.4.6

### Patch Changes

- 2daa891: Bundled troubleshooting Skills no longer appear in the model's system prompt. Each now sets `disable-model-invocation: true`, so installing the package adds no per-turn context and you no longer need `skills` package filters to hide them. To open one, use `/skill:<package>` or a `$<package>` Skill Reference. Packages whose failures the model can see append that package's Skill path to configuration and runtime failures, so the model loads the guide only when one occurs.

## 0.4.5

### Patch Changes

- 1a7c706: Stop declaring an output schema that describes only display details. Pi's built-in `codemode` returns structured results for tools with an output schema, which would hide raw results from scripts; scripts now receive the complete text result as declared.
- be50c8c: Add `updateFileLocked` (`@ian-pascoe/pi-utils/locked-file-update`), which atomically updates a file under Pi's native settings lock. LSP and Minimal Subagents settings commands now share it.
- Updated dependencies [be50c8c]
- Updated dependencies [be50c8c]
  - @ian-pascoe/pi-utils@0.3.0

## 0.4.4

### Patch Changes

- 8af327e: Show up to eight rendered rows of Post-edit Diagnostics in the collapsed transcript entry while keeping the expanded entry complete.

## 0.4.3

### Patch Changes

- 7b5b785: Fix LSP and DAP startup with `pi --no-session` by using a private OS temporary directory when Pi supplies an empty session directory. Result Spills and stderr files retain their existing permissions and normal teardown cleanup.

## 0.4.2

### Patch Changes

- 981f655: Register the `lsp` tool with an object-shaped parameter schema so providers that validate tool schemas strictly accept requests.

  The tool's parameters were a `Type.Union([...])` of 35 per-operation branches. A top-level union
  serialises to `anyOf` with no `type`, and DeepSeek rejects every request while such a tool is
  registered:

  ```
  400 invalid_request_error: Invalid schema for function 'lsp':
  schema must be a JSON Schema of 'type: "object"', got 'type: null'.
  ```

  Because the tool is registered in every request this failed turns that never used the tool at all,
  so the package made Pi unusable on that provider.

  Wrapping the union (for example `{ type: "object", anyOf: [...] }`) is not an option: Pi's
  constrained-sampling helper rejects object and array unions and requires a root schema of
  `type: "object"`, so the registered schema has to be a plain object.

  `LspToolParametersSchema` is unchanged and still the strict per-operation validator applied at the
  tool ingress, so an incomplete or contradictory argument set is still rejected with the existing
  `Pi LSP: invalid tool arguments` failure. A new `LspToolProviderParametersSchema` — a flat object
  whose fields reuse the same per-field schemas — is what Pi now registers and what the model sees. A
  contract test asserts the registered schema is an object and pins it to the validation branches:
  every operation the branches use must be accepted, the two field sets must be equal, and each field
  must reuse the branch schema verbatim, so the two cannot drift.

  The tool description lists the required fields for every operation, derived from the strict
  branches, so models retain argument guidance without reintroducing a top-level union.

## 0.4.1

### Patch Changes

- 1a2e2b9: Remove lint workarounds from package code

## 0.4.0

### Minor Changes

- cbe44d2: Add `/lsp` status and action pickers with stop, enable, and disable shortcuts. Preserve branch-local session enablement across reloads and resumes, support project/global overrides, and safely retire stopped or disabled server processes before lazy startup.

## 0.3.2

### Patch Changes

- 8e665f5: Preserve custom fixed-name tool rendering when Pi reloads extensions.

## 0.3.1

### Patch Changes

- 5cdd3b5: Update dependencies

## 0.3.0

### Minor Changes

- 841a7df: Add bounded CodeMode tool discovery and typed tool result schemas across supporting extensions.

## 0.2.1

### Patch Changes

- 4e356a8: Bump dependencies

## 0.2.0

### Minor Changes

- 706d063: Add package skills that guide Pi through extension configuration and diagnosis.

## 0.1.1

### Patch Changes

- 36785a2: Quarantine invalid server definitions and timeout fields without disabling unrelated valid LSP settings. Exclude formatting-only servers from Post-edit Diagnostics.
