# Pi LSP context

## Glossary

- **Activation Gate** — an optional requirement that at least one configured root marker be present for a Server Definition to apply to a candidate file.
- **LSP Diagnostic** — a source-code problem reported by a language server. This is distinct from Pi's resource-loading diagnostics.
- **Post-edit Diagnostics** — LSP Diagnostics for affected files appended to a Supported Mutation Tool result, including a partial failure that changed files.
- **Post-edit Diagnostics Entry** — a model-invisible session transcript summary of reportable Post-edit Diagnostic outcomes from one assistant tool batch. It complements, but does not duplicate in model context, the diagnostics appended to mutation results.
- **Supported Mutation Tool** — a file-modifying Pi tool whose affected paths the extension can identify exactly. Native `edit`, native `write`, Codex-style `apply_patch`, and LSP preview application are the initial Supported Mutation Tools.
- **Workspace Edit Preview** — a proposed set of language-server changes with the source versions needed to reject a stale application.
- **Validated Workspace Edit** — a Workspace Edit Preview whose source versions and paths still match at application time. It is applied as one guarded batch with rollback on failure, not as a crash-atomic filesystem transaction.
- **Result Spill** — the complete LSP operation output referenced when the model-visible result reaches Pi's standard output limit.
- **Server Definition** — a configured language-server command, language mapping, workspace-root policy, Activation Gate, and protocol settings identified by a stable server ID. A project Server Definition replaces a global definition with the same ID; an invalid project replacement shadows the global definition and is quarantined.
- **Server Instance** — one running language-server process for a Server Definition and a detected workspace root.
- **Capable Server Instance** — a Server Instance that currently advertises support for the requested operation through static or dynamic capabilities.
- **Mutation Manifest** — the exact file operations and absolute paths of a Validated Workspace Edit exposed to Pi's pre-execution tool hooks.

## Behavior boundary

The extension provides agent-useful language-server operations through one Pi tool. Mutating operations produce a Workspace Edit Preview and require a separate apply operation. Apply requires a Validated Workspace Edit and may include file creation, deletion, or renaming.

Language-server requests to apply edits are also converted into Workspace Edit Previews; servers never bypass explicit application. The extension imposes no workspace path boundary on a Validated Workspace Edit. Before application, its verified Mutation Manifest is visible to other extensions, which may block the tool call.

Language-server documents are valid UTF-8 text. Content edits follow existing symlinks and identify the canonical target in the Mutation Manifest; resource operations act on the named directory entry. Conflicting or non-file workspace edits are rejected before they become applicable previews.

Server Definitions come only from the `lsp` key in Pi's global and trusted project settings. Pi's standard reload lifecycle reloads configuration. Server Instances start lazily, are reused within the Pi session, and require an explicit restart after failure. Read operations may query several matching Server Instances; a mutation must identify one when several match.

An Activation Gate is evaluated independently for every candidate file. A Server Definition that
does not pass its gate is excluded from automatic routing without warning. Changes to root markers
take effect on the next route. An explicit request for a language-compatible Server Definition may
distinguish a missing required root marker from a language mismatch.

When several Server Instances handle a read, successful results remain useful even if another instance fails. Failures stay labeled by server rather than replacing successful output.

The extension does not own language-server installation, a built-in server catalog, formatting outside LSP, static parsing, or debugging. Those capabilities belong in separate additions only after demonstrated need.

Post-edit Diagnostics apply whenever a Supported Mutation Tool reports affected files, including partial failures. Only Server Instances that advertise document diagnostics participate. A successful mutation remains successful when Post-edit Diagnostics are unavailable. Pi's standard output limit never discards LSP output; excess output remains available as a Result Spill.
