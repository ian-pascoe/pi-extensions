# Pi LSP context

## Glossary

- **Activation Gate** — an optional requirement that at least one configured root marker be present for a Server Definition to apply to a candidate file. Workspace root markers never satisfy it.
- **LSP Diagnostic** — a source-code problem reported by a language server. This is distinct from Pi's resource-loading diagnostics.
- **Post-edit Diagnostics** — LSP Diagnostics for affected files appended to a Supported Mutation Tool result, including a partial failure that changed files.
- **Post-edit Diagnostics Entry** — a model-invisible session transcript summary of reportable Post-edit Diagnostic outcomes from one assistant tool batch. It complements, but does not duplicate in model context, the diagnostics appended to mutation results.
- **Supported Mutation Tool** — a file-modifying Pi tool whose affected paths the extension can identify exactly. Native `edit`, native `write`, Codex-style `apply_patch`, and LSP preview application are the initial Supported Mutation Tools.
- **Workspace Edit Preview** — a proposed set of language-server changes with the source versions needed to reject a stale application.
- **Validated Workspace Edit** — a Workspace Edit Preview whose source versions and paths still match at application time. It is applied as one guarded batch with rollback on failure, not as a crash-atomic filesystem transaction.
- **Result Spill** — the complete LSP operation output referenced when the model-visible result reaches Pi's standard output limit (it holds the complete text), or when a structured result exceeds its 1 MiB cap and is bounded (it holds the complete structured data as JSON).
- **Structured Result** — the JSON `structuredContent` of an LSP tool result, which programmatic callers such as codemode scripts receive. It is kept out of model context, is capped at 1 MiB like Pi's built-in `bash` tool, and is bounded deterministically (longest strings and array tails cut, identifying fields kept, `structured_truncated: true`) when larger. `truncated` also covers a cut of only the model-visible text.
- **Server Definition** — a configured language-server command, language mapping, workspace-root policy (the nearest root marker by default, or the nearest workspace root marker such as `pnpm-workspace.yaml` so one Server Instance covers a monorepo), Activation Gate, and protocol settings identified by a stable server ID. A project Server Definition replaces a global definition with the same ID; an invalid project replacement shadows the global definition and is quarantined.
- **Server Instance** — one running language-server process for a Server Definition and a detected workspace root.
- **Stop** — ending a Server Instance without preventing a later lazy start for its Server Definition.
- **Disabled Server Definition** — a Server Definition that is ineligible to start Server Instances until it is enabled.
- **Server Enablement Override** — an explicit enabled or disabled choice for a Server Definition at session, project, or global scope. A session-scoped choice belongs to the selected session history and does not apply when navigating before it.
- **Capable Server Instance** — a Server Instance that currently advertises support for the requested operation through static or dynamic capabilities.
- **Mutation Manifest** — the exact file operations and absolute paths of a Validated Workspace Edit exposed to Pi's pre-execution tool hooks.

## Behavior boundary

The extension provides agent-useful language-server operations through one Pi tool per operation. Mutating operations produce a Workspace Edit Preview and require a separate apply tool call. Apply requires a Validated Workspace Edit and may include file creation, deletion, or renaming.

Language-server requests to apply edits are also converted into Workspace Edit Previews; servers never bypass explicit application. The extension imposes no workspace path boundary on a Validated Workspace Edit. Before application, its verified Mutation Manifest is visible to other extensions, which may block the tool call.

A tool call discards the Workspace Edit Previews it created when its returned result does not name them, including when the call fails, a server's code-action listing fails, or building the result fails. Server-initiated previews are not discarded: they are held until a result reports them, and a failed call hands them back for the next result. A read rejects only after every queried Server Instance that already started its request has answered or failed.

Language-server documents are valid UTF-8 text. A result position is converted only against the text of the file it lies in; positions in a file without readable text are approximated and named in a warning, never converted against another file's text. A position that disagrees with a readable file's current text never fails the server's result: a character past the line end is clamped to it without a warning, as the LSP specification says; a line past the document end keeps the position, a character inside a Unicode character snaps to its start, and a warning names the file, because it changed since the server read it or the server sent an invalid position. Content edits follow existing symlinks and identify the canonical target in the Mutation Manifest; resource operations act on the named directory entry. Conflicting or non-file workspace edits are rejected before they become applicable previews. A code action whose edit fails this validation is listed as not applicable, with the reason, while the server's other actions remain.

Server Definitions come only from the `lsp` key in Pi's global and trusted project settings. Pi's standard reload lifecycle reloads configuration. Server Instances start lazily, are reused within the Pi session, and retain failure state until explicit recovery. Read operations and code-action listing may query several matching Server Instances; a rename or formatting preview must identify one when several match. References and rename name the root of the Server Instance they searched and warn when other roots of the same Server Definition exist, because files under those roots may be missing from the result. A directory counts as another root only when its files route to a different Server Instance; packages inside a searched workspace root do not. Because a language server searches only packages it has loaded, references and rename in a workspace root also name its packages (directories holding a root marker) where the Server Instance has no synchronized document; the extension never opens files to load them (ADR-0004). Workspace root selection never uses the home directory or anything above it unless the working directory is there.

An Activation Gate is evaluated independently for every candidate file. A Server Definition that
does not pass its gate is excluded from automatic routing without warning. Changes to root markers
take effect on the next route. An explicit request for a language-compatible Server Definition may
distinguish a missing required root marker from a language mismatch. Post-edit Diagnostics stay
silent about such a file too.

When several Server Instances handle a read, successful results remain useful even if another instance fails. Failures stay labeled by server rather than replacing successful output.

The extension does not own language-server installation, a built-in server catalog, formatting outside LSP, static parsing, or debugging. Those capabilities belong in separate additions only after demonstrated need.

Post-edit Diagnostics apply whenever a Supported Mutation Tool reports affected files, including partial failures. Only Server Instances that advertise document diagnostics participate. Findings use paths relative to the working directory and named severities, and an all-clean result is one line. A file with a finding from any server is never listed as clean, even when another server found it clean. A changed file that no enabled Server Definition covers, because none handles its language or its Activation Gate fails, is left silent, as is a file whose matching Server Definitions are all disabled; when no changed file is covered by an enabled Server Definition, no diagnostics section is appended (an `apply_patch` adapter-version warning still is). A Server Instance of a covering Server Definition that fails or times out is still reported. A successful mutation remains successful when Post-edit Diagnostics are unavailable. Neither Pi's standard output limit nor the Structured Result cap discards LSP output; excess output remains available as a Result Spill.
