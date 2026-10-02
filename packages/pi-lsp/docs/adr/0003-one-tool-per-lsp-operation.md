# One Pi tool per LSP operation

Each LSP operation is its own Pi tool, named `lsp_<operation>` and grouped under the `lsp` namespace. This replaces the single `lsp` tool, which had one operation-discriminated schema. Now that codemode can call tools from scripts, each tool can carry its own small declaration and exact tool annotations. Permission extensions can then tell read-only queries apart from the destructive `lsp_apply`. Before, the model had to read a table of required fields per operation, and every call had one generic risk profile.

Nine core tools are declared to the model (`direct` exposure): `lsp_diagnostics`, `lsp_hover`, `lsp_goto_definition`, `lsp_find_references`, `lsp_document_symbols`, `lsp_workspace_symbols`, `lsp_rename`, `lsp_code_actions`, and `lsp_apply`. They cover the read queries agents use for navigation and diagnostics, and the two edit producers whose results agents act on. `lsp_apply` must be declared so that every Workspace Edit Preview, including one in a resumed session, can be applied. We kept `lsp_status`, `lsp_capabilities`, and `lsp_restart` out of the core: they serve diagnosis, which starts from the user-invoked troubleshooting Skill (ADR-0005 of the repository), and the user has `/lsp` for status and `/lsp stop` for recovery. The formatting previews stay out too, since Pi Formatter owns routine formatting.

## Long-tail exposure

The other 26 tools use `codemode` exposure rather than `deferred`. Pi lists `codemode` tools, with TypeScript declarations grouped under their namespace, in the `codemode` tool description, so scripts can call them without a search. `tool_search` still finds and declares both kinds. The listing shares the `codemode.inlineBudget` (3000 estimated tokens by default) with other extensions; tools that do not fit stay findable with `searchTools()` and `describeNamespace("lsp")`.

Neither `codemode` nor `tool_search` is on by default. Without them, the fallback is activation by name: Pi activates an inactive extension tool named in `defaultTools` (`"+lsp_status"`) or `--tools`. The README and the troubleshooting Skill document all three paths.

## Shared rules

The rules every tool shares (one-based Unicode coordinates, an optional leading `@` in paths, Result Spill, preview-then-apply, server selection) live in `namespace.instructions` for scripts. Pi 0.99 has no `instructions` field and never shows it for declared tools, so the rules also reach the model as one identical `promptGuidelines` entry on every tool, which Pi deduplicates. The facts a call cannot be correct without stay on the tool itself: `line` and `character` are described as one-based in their schemas, and each preview tool's description names `lsp_apply`. Custom system prompts that drop guidelines therefore still see them.

## Annotations

Queries, `lsp_status`, and `lsp_capabilities` are read-only, idempotent, and closed-world. The preview producers (`lsp_rename`, `lsp_code_actions`, `lsp_format_*`) are also marked read-only: they only record a session-local Workspace Edit Preview, and no file changes until `lsp_apply` runs with its verified Mutation Manifest (ADR-0002). This lets permission extensions confirm only the call that writes. `lsp_restart` changes no data but is not read-only; it is idempotent and non-destructive. `lsp_apply` is destructive and not idempotent. All tools are closed-world, since they talk only to configured local servers.

## Structured results

Every tool declares an `outputSchema` and returns matching `structuredContent`. An earlier release removed the single tool's output schema because it described only the result details, which omit raw protocol payloads, so codemode scripts would have received less than the text. The structured results now carry the complete data: each server's normalized response for reads, and full preview and apply data for mutations. Pi keeps `structuredContent` out of model context and session history, so the output limit does not cut it; it reports `truncated` and `spill_path` when the model-visible text was cut. `tool_result` handlers that append text (Post-edit Diagnostics, Pi Formatter) return the structured result with the new content, because Pi otherwise drops it.

An `lsp_apply` partial failure returns `isError: true` with its structured result, so scripts receive `state: "partial_failure"` and the changed paths. Post-edit Diagnostics no longer changes the error state.

## Considered Options

- **Keep the single tool.** Rejected: codemode would still show one large union, and annotations could not differ per operation.
- **Group related operations** (hierarchies, formatting). Rejected: grouping brings back operation-specific field rules and mixed annotations.
- **Keep `lsp` as a hidden alias for one release.** Rejected: the package is pre-1.0, and an alias would keep two contracts in circulation.
- **Use `deferred` exposure for the long tail.** Rejected: deferred tools are never listed for codemode scripts, which would have to search before every call.

## Consequences

The `lsp` tool is removed without an alias, in a breaking minor release. Code that reads tool results (preview replay, Post-edit Diagnostics, and the formatter in `pi-formatter`) recognizes results by details kind plus a tool-name allow-list that includes the legacy `lsp`, indefinitely, so resumed sessions keep their Workspace Edit Previews and apply them with `lsp_apply`. Legacy results render with Pi's default renderer. Settings that grant `lsp` by exact name must be updated. Declaring nine tools costs about 300 more tokens than the single tool did, and with codemode active the namespace listing adds up to its share of the inline budget.
