# Add the `@ian-pascoe/pi-lsp` package

**Status:** Ready for implementation

## Outcome

Add a source-TypeScript Pi extension package that launches user-configured language servers, exposes one strict `lsp` tool, and appends fresh diagnostics after known file-mutation tools. Language-server mutations use the package's documented Workspace Edit Preview → Validated Workspace Edit flow.

Read before implementation:

- [`../../AGENTS.md`](../../AGENTS.md)
- [`../../CONTEXT-MAP.md`](../../CONTEXT-MAP.md)
- [`../../packages/pi-lsp/CONTEXT.md`](../../packages/pi-lsp/CONTEXT.md)
- both package ADRs in [`../../packages/pi-lsp/docs/adr/`](../../packages/pi-lsp/docs/adr/)
- [`../agents/domain.md`](../agents/domain.md)
- [`../adr/0002-publish-pi-extensions-as-source-typescript.md`](../adr/0002-publish-pi-extensions-as-source-typescript.md)
- [`../../.oxlintrc.json`](../../.oxlintrc.json)

The existing `CONTEXT-MAP.md`, package context, and package ADRs are approved inputs. Preserve their preview/apply language if another concurrent edit reintroduces immediate LSP mutation.

## Boundaries

- Register one `lsp` tool and one post-mutation diagnostics hook. Keep `src/index.ts` a thin extension entrypoint.
- Read server definitions only from the `lsp` key in Pi's trust-aware global and project `settings.json` layers.
- Launch installed commands over stdio. The package owns no server catalog, installer, formatter outside LSP, static parser, debugger, status widget, slash command, setup wizard, or background file watcher.
- Use `vscode-languageserver-protocol` for JSON-RPC/LSP and `cross-spawn` for safe PATH, shebang, and Windows command-shim handling. Spawn with `shell: false`.
- Keep server processes session-scoped and lazy. Pi's `/reload` is the configuration reload path.
- Apply Pi's standard 2,000-line/50-KB output limit to every operation and save complete truncated output as a Result Spill.
- Publish source TypeScript only. Add no `dist`, build script, `main`, `types`, or `exports` contract.
- Prepare version `0.1.0` for the repository's manual scoped-package bootstrap. Add no bootstrap Changeset and run no publish command.

## Runtime contract

### Settings

Resolve this optional shape independently from `SettingsManager.getGlobalSettings()` and `getProjectSettings()`:

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
        "rootMarkers": ["tsconfig.json", "package.json", ".git"],
        "initializationOptions": {},
        "settings": {},
        "environment": {}
      }
    }
  }
}
```

Rules:

- Every field is optional except an enabled server's `command` and non-empty `languages`.
- Each language requires a non-empty `languageId` and at least one `extensions` or exact `fileNames` entry.
- `rootMarkers` are basename glob patterns. The nearest matching ancestor is the Server Instance root; `ctx.cwd` is the fallback.
- Global and project timeout objects merge by field. Defaults are the values above.
- Global and project server maps merge by ID, but a project value replaces the complete global Server Definition. `null` removes an inherited server.
- `initializationOptions` and `settings` are separate opaque JSON values. Send the former in `initialize` and the latter through `workspace/didChangeConfiguration` and `workspace/configuration` responses.
- Merge `environment` over `process.env`; a `null` value removes an inherited variable.
- Unknown `lsp`, timeout, Server Definition, or language-mapping fields are validation errors. A malformed `lsp` layer disables all LSP startup and remains visible through `status` until fixed.
- A missing `lsp` key is valid and produces an empty server map.

Reuse the trust-aware `SettingsManager` construction and wire-value parsing pattern in [`../../packages/pi-minimal-subagents/src/minimal-subagents-extension.ts`](../../packages/pi-minimal-subagents/src/minimal-subagents-extension.ts) and [`../../packages/pi-minimal-subagents/src/minimal-subagents-config.ts`](../../packages/pi-minimal-subagents/src/minimal-subagents-config.ts). Parse the unknown `lsp` field with TypeBox instead of asserting it onto Pi's `Settings` type.

### Tool operations

Build one TypeBox discriminated union. Each branch is a strict object with one of these `snake_case` operation values:

```text
status
capabilities
restart
diagnostics
workspace_diagnostics
completion
hover
signature_help
declaration
goto_definition
goto_type_definition
goto_implementation
find_references
document_highlights
document_symbols
workspace_symbols
document_links
call_hierarchy
incoming_calls
outgoing_calls
type_hierarchy
supertypes
subtypes
selection_ranges
folding_ranges
code_lenses
inlay_hints
document_colors
format_document
format_range
format_on_type
prepare_rename
rename
code_actions
apply
```

Use these argument rules:

- `status` has no target and never starts a server.
- `capabilities` and `restart` require `server_id` and `file_path` so one Server Instance is resolved exactly.
- File reads require `file_path`; position reads also require one-based `line` and `character`. Agent-facing characters count Unicode code points and convert at the protocol boundary to the server's negotiated UTF-8, UTF-16, or UTF-32 encoding.
- `workspace_diagnostics` requires `server_id` and a `file_path` root anchor. Use protocol workspace diagnostics when available and cached push diagnostics otherwise; never crawl the project to open files.
- `workspace_symbols` requires `query` and a `file_path` root anchor. An optional `server_id` narrows read operations; otherwise query every matching capable server.
- `find_references` accepts optional `include_declaration`.
- Hierarchy follow-up operations accept a file position and perform their prepare request internally rather than exposing protocol item payloads.
- `selection_ranges` accepts one or more one-based positions.
- Formatting branches require `tab_size` and `insert_spaces`; trailing-whitespace and final-newline options are optional. Range/on-type branches also require their range or trigger character.
- `rename` requires `new_name`. `code_actions` accepts a range and optional action-kind filters.
- `apply` requires `preview_id`; `prepareArguments()` adds the canonical optional `mutation_manifest` before schema validation and every `tool_call` hook.
- A mutating operation's `server_id` may be omitted only when exactly one matching capable Server Instance exists.

Validate again inside `execute()` because later `tool_call` handlers may mutate an already validated input. Use operation-specific errors with a stable `Pi LSP:` prefix. Return compact deterministic text in `content` and schema-validated normalized state in `details`.

### Server and document behavior

- Keep one Server Instance per `(server ID, nearest root)` and one in-flight startup promise per key.
- Start an instance on its first explicit operation or first Post-edit Diagnostics request. Mark startup/protocol/process failure unavailable until explicit `restart` or Pi `/reload`.
- Read operations query every matching capable instance. Return successful results with labeled warnings when some instances fail; fail only when none succeeds.
- Keep at most 100 open documents per instance. Read valid UTF-8 with fatal decoding, preserve a UTF-8 BOM, send `didOpen`/`didChange`, and evict with `didClose` in least-recently-used order.
- Support push diagnostics, static/dynamically registered document and workspace pull diagnostics, and authoritative empty responses. After a changed document is synchronized, race fresh push/pull work until `diagnosticsMs`; report timeout separately from zero diagnostics.
- Implement the server requests needed by the agreed client: configuration, workspace folders, capability registration/unregistration, progress/log messages, diagnostics refresh, and `workspace/applyEdit`. Return JSON-RPC `MethodNotFound` for other requests and advertise no filesystem-watcher support.
- Preserve readable non-file URIs such as `jar:` in read results. Only `file:` URIs can enter a Workspace Edit Preview.
- Bridge tool cancellation to JSON-RPC cancellation. A Validated Workspace Edit honors cancellation before its first mutation, then finishes or rolls back its guarded batch.
- Shut down gracefully within `shutdownMs`, then terminate the process. Capture the latest 1 MB of stderr in the session temp directory and include its path in startup, timeout, protocol, or exit failures.

### Workspace edits

All `rename`, formatting, and edit-bearing code-action responses become persisted Workspace Edit Previews. `code_actions` returns a preview ID for each edit-only action; command-bearing actions remain visible and non-applicable. A server `workspace/applyEdit` request receives `applied: false` and its edit is exposed as a preview through the active `lsp` result.

Normalize a preview before persistence:

- resolve text-document and resource-operation `file:` URIs;
- support regular-file create, modify, delete, and rename operations, including LSP overwrite/ignore flags;
- reject directory-tree operations, non-file URIs, invalid UTF-8, overlapping text edits, contradictory resource operations, and invalid destinations;
- record expected existence, SHA-256 content hashes, file modes, canonical content targets, and named resource paths;
- retain enough protocol data in schema-validated tool-result `details` to replay the current session branch after reload/resume.

At `session_start`, replay `lsp` tool-result details on `ctx.sessionManager.getBranch()` to rebuild available/applied preview state. For a valid apply call, `prepareArguments()` replaces any caller-provided manifest with canonical absolute entries. Document this `mutation_manifest` shape in the package README so a permission extension can block the call. Recheck the manifest, preview state, file hashes, presence, modes, and destinations inside `execute()`.

Acquire `withFileMutationQueue()` for every canonical path in sorted order, revalidate inside the queues, apply through temporary-file replacement, and preserve file modes/BOMs. Content edits follow existing symlinks and expose the canonical target; rename/delete resource operations address the named directory entry. Keep originals in memory for rollback. On failure, roll back completed operations in reverse order and report any recovery failure with exact paths. The contract is guarded and rollback-capable, not crash-atomic.

### Post-edit Diagnostics

Register one `tool_result` handler and preserve the incoming `content`, `details`, and `isError`. Recognize affected paths through structural adapters:

| Tool          | Exact adapter                                                                                                                            |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `edit`        | string `event.input.path`                                                                                                                |
| `write`       | string `event.input.path`                                                                                                                |
| `apply_patch` | `details.status` plus `details.result.changedFiles`, `createdFiles`, `deletedFiles`, and `movedFiles` from current `pi-codex-conversion` |
| `lsp` `apply` | verified input Mutation Manifest plus actual apply result details                                                                        |

Run diagnostics for changed/created/renamed destination files after success and after a partial failure that changed files. Deleted paths need no document diagnostics. If the known `apply_patch` result shape changes, preserve its result and append an adapter-version warning; maintain no second patch parser.

Append one LSP section for every recognized mutation result, including explicit `no diagnostics`, `no configured server`, timeout, unavailable-server, and adapter-warning outcomes. Sort by severity, path, position, and server ID while preserving duplicates from independent servers. Diagnostics never change the mutation's success/error state.

## Intended module map

Use concept names that remain unique under repository-wide search. Start with these owners and merge a file only when the result remains cohesive; add no bare `config.ts`, `types.ts`, `utils.ts`, or forwarding-only service.

| File                               | Sole owner                                                                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                     | Thin default export                                                                                     |
| `src/pi-lsp-extension.ts`          | Pi registration and session lifecycle                                                                   |
| `src/pi-lsp-settings.ts`           | Settings wire schemas, defaults, validation, and global/project resolution                              |
| `src/lsp-server-manager.ts`        | File matching, root selection, Server Instance registry, routing, status, restart, shutdown             |
| `src/lsp-server-client.ts`         | Process, JSON-RPC connection, initialization, capabilities, document sync, diagnostics, server requests |
| `src/lsp-position-encoding.ts`     | One-based code-point ↔ negotiated LSP position conversion                                               |
| `src/lsp-tool-contract.ts`         | Discriminated input and persisted result-detail schemas                                                 |
| `src/lsp-tool.ts`                  | Tool registration, operation dispatch, and capability-specific requests                                 |
| `src/lsp-tool-output.ts`           | Deterministic model text and normalized result formatting                                               |
| `src/lsp-workspace-edit.ts`        | Preview normalization, replay, manifest preparation, validation, application, and rollback              |
| `src/lsp-post-edit-diagnostics.ts` | Mutation adapters and result augmentation                                                               |
| `src/lsp-session-files.ts`         | Mode-safe temp directory, Result Spills, and bounded server stderr files                                |

Keep domain types beside their owner and export only symbols used by another module. Give every export a one-line constraint comment and a domain-qualified name.

## Implementation sequence

### 1. Establish the baseline and package shell

Record:

```bash
git status --short
git rev-parse HEAD
pnpm verify
pnpm changeset:status
```

The expected starting changes are `CONTEXT-MAP.md`, `packages/pi-lsp/CONTEXT.md`, the two package ADRs, and this plan. Stop for review if unrelated source changes are present.

Create:

- `packages/pi-lsp/package.json` as public `@ian-pascoe/pi-lsp@0.1.0` with the repository's source-package metadata, scripts, Node engine, and `pi.extensions: ["./src/index.ts"]`;
- runtime dependencies `vscode-languageserver-protocol@^3.17.5` and `cross-spawn@^7.0.6`;
- wildcard peers for `@earendil-works/pi-coding-agent` and `typebox`;
- package development dependency `@types/cross-spawn@^6.0.6`;
- `tsconfig.json`, package-local MIT `LICENSE`, an initial README, and the thin entrypoint/lifecycle shell.

Use NodeNext `.js` local import specifiers. Let `pnpm install` update the workspace lockfile. Add a package entrypoint smoke test before wiring the package into the root manifest.

**Complete when:** the new package installs, typechecks, its source entrypoint loads through Pi without starting a server, and its packed file contract can contain only `src`, README, LICENSE, and `package.json`.

### 2. Parse settings and route files to Server Definitions

Implement `pi-lsp-settings.ts` and the pure matching/root-selection portion of `lsp-server-manager.ts`. Read the configuration/resources and parsing/testing references from the coding standards before editing this boundary.

Add focused tests for:

- defaults and an absent `lsp` key;
- project trust exclusion through a real temporary `SettingsManager`;
- timeout field overrides;
- whole-server project replacement and `null` deletion;
- strict unknown-field and malformed-layer failure;
- separate opaque initialization/settings values;
- environment overlay/removal;
- extension and exact-file-name matching;
- basename-glob root markers and nearest-root/fallback selection;
- multiple servers matching one file.

Use real temporary global/project settings files and explicit inputs; use no module mocks.

**Complete when:** every authored settings value is either parsed into a valid resolved type or reported with its global/project path, no invalid layer starts a server, and every routing decision is deterministic in tests.

### 3. Build the real TypeScript LSP tracer

Before implementing client lifecycle, read:

- [Pi extension lifecycle and tool documentation](../../.repos/pi/packages/coding-agent/docs/extensions.md)
- [`../../.repos/opencode/packages/opencode/src/lsp/client.ts`](../../.repos/opencode/packages/opencode/src/lsp/client.ts)
- [`../../.repos/opencode/packages/opencode/src/lsp/lsp.ts`](../../.repos/opencode/packages/opencode/src/lsp/lsp.ts)
- [`../../.repos/opencode/packages/opencode/src/lsp/server.ts`](../../.repos/opencode/packages/opencode/src/lsp/server.ts)

Implement the narrow vertical slice through session files, position encoding, one client, and the manager. Start with the repository's installed TypeScript 7 server, verified as:

```bash
pnpm exec tsc --lsp --stdio
```

The integration test should create a temporary TypeScript project, resolve the repository's actual `node_modules/.bin/tsc`, configure `--lsp --stdio`, and exercise the package's manager/client interface. Prove initialization reports `typescript-go`, one semantic diagnostic is received, one definition resolves, UTF-8 text is synchronized, and shutdown leaves no live child. Keep the fixture outside package typechecking and clean it in `finally`.

**Complete when:** the real TypeScript 7 integration goes red without the implementation and green through the package's public runtime interface, with bounded startup/request/shutdown waits and no credential/network dependency.

### 4. Complete server lifecycle and diagnostics

Extend the tracer into the full Server Instance contract:

- startup deduplication and unavailable/restart state;
- every matching-server read route;
- full/incremental text synchronization, save/close behavior, and 100-document LRU;
- negotiated position encoding;
- static/dynamic capabilities and the agreed server requests;
- push, document-pull, and workspace-pull diagnostics with fresh/empty/timeout distinction;
- AbortSignal cancellation;
- Result Spill directory and 1-MB stderr tail;
- graceful shutdown followed by termination.

Use a tiny child-process fake server only for deterministic branches that TypeScript 7 cannot reliably produce: delayed cancellation, dynamic registration, malformed/protocol failure, stderr/exit, and server-initiated `workspace/applyEdit`. Make the fake speak real Content-Length JSON-RPC over stdio.

**Complete when:** every client state transition and server-request branch has a real-process check, partial multi-server failure retains successful results, and reload/shutdown closes every tracked process and file handle.

### 5. Register the complete read-only `lsp` surface

Implement `lsp-tool-contract.ts`, `lsp-tool.ts`, and `lsp-tool-output.ts`. Read Pi's Custom Tools and Output Truncation sections immediately before registering the tool.

Create one strict TypeBox object per operation and unite them as the accepted discriminated union. Keep branch-specific required fields in the schema. Re-parse prepared/mutated arguments in `execute()`. Implement `status`, `capabilities`, `restart`, and every non-mutating operation from the Runtime contract. Resolve code actions, code lenses, completion items, links, hints, and workspace symbols internally only when the server requires resolution for the promised result; expose no raw resolve operation.

Format paths, ranges, server IDs, severity, and capability failures consistently. Normalize a leading `@` on tool paths. Apply `truncateHead()` to every text result; when truncated, write the full text through `lsp-session-files.ts` and return the exact spill path. Keep structured `details` bounded to normalized data required by rendering, replay, or application rather than duplicating raw output.

Test through the registered tool definition and real ExtensionContext/recording Pi API seam. Cover every discriminated branch's validation and dispatcher selection; use representative protocol responses rather than one test per formatting line.

**Complete when:** the schema contains exactly the agreed operation strings, invalid branch arguments fail before a request, all read operations either return normalized results or a precise capability/error result, and every oversized result names a readable complete spill file.

### 6. Implement Workspace Edit Preview and guarded apply

Implement `lsp-workspace-edit.ts` and wire `format_*`, `rename`, edit-bearing `code_actions`, server `workspace/applyEdit`, and `apply` into the tool. Read Pi's file-mutation queue documentation and the workflow/transaction, parsing, domain-state, and testing coding-standard references before editing this path.

Test at minimum:

- multi-file text previews and exact unified summaries;
- code-action previews and command-bearing action rejection;
- create/modify/delete/rename-file operations and LSP overwrite/ignore flags;
- non-file URI, invalid UTF-8, directory, overlap, duplicate destination, and contradictory-operation rejection;
- UTF-8 BOM and mode preservation;
- symlink content-target versus resource-entry behavior;
- preview replay from only the active session branch;
- one-use/applied preview state and stale hash/presence/destination checks;
- canonical Mutation Manifest insertion before `tool_call` hooks, rejection after a hook mutates it, and no workspace path restriction;
- sorted multi-path queues, cancellation before mutation, reverse rollback, and an explicit recovery error when rollback itself fails;
- capture of server-initiated apply requests as non-applied previews.

Exercise real files under temporary directories. Inject narrow filesystem failure points through the Workspace Edit owner's constructor/operations rather than mocking Node modules.

**Complete when:** no LSP mutation can write before a preview is persisted, every apply is stale/conflict checked inside acquired queues, permission hooks see the verified manifest before writes, and every failed batch either restores the initial filesystem or reports exact unrecovered paths.

### 7. Append Post-edit Diagnostics through tool-result middleware

Implement `lsp-post-edit-diagnostics.ts` and register it from the extension lifecycle. Before editing, reread Pi's `tool_call`/`tool_result` chaining contract and the current Codex implementation at [`pi-codex-conversion`](https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/main/packages/pi-codex-conversion).

Use structural schemas for all four adapters. For current Codex conversion, recognize:

```text
toolName: apply_patch
details.status: success | partial_failure
details.result: changedFiles[], createdFiles[], deletedFiles[], movedFiles[], fuzz
```

Add tests proving:

- native `edit` and `write` path extraction;
- same-name `edit` replacement compatibility through central Pi events;
- current `apply_patch` success and partial-failure extraction without importing that package;
- explicit adapter warning for a changed/unknown shape;
- `lsp apply` paths come from the verified manifest/result;
- startup on first matching mutation;
- every matching server's fresh diagnostics, including authoritative empty and timeout results;
- exact preservation of original content/details/error state while appending one text block;
- deterministic ordering, duplicate preservation, and Result Spill behavior;
- deleted/nonmatching files and no-config/no-server states.

Use the real TypeScript 7 server for one edit-to-diagnostic end-to-end test. Keep structural fixtures for other tool result shapes.

**Complete when:** every Supported Mutation Tool result receives an explicit LSP outcome, partial mutation failures still diagnose changed files, arbitrary edit implementations with the native path contract work, and diagnostics never change the original tool's success state.

### 8. Finish package and repository integration

Complete `packages/pi-lsp/README.md` as the user-facing source for:

- npm/Git installation and the requirement to install server binaries separately;
- the exact `lsp` settings schema, defaults, replacement rules, and TypeScript 7 example;
- all operation names and one-based Unicode-code-point coordinates;
- formatting arguments;
- multiple-server routing and workspace-diagnostic behavior;
- Post-edit Diagnostics adapters and Codex compatibility boundary;
- preview/apply, command-bearing code actions, Mutation Manifest permission hook, rollback limits, and unrestricted paths;
- standard truncation/Result Spills and stderr paths;
- `/reload`, lazy lifecycle, explicit restart, UTF-8, and non-file URI behavior;
- security: trusted project settings can launch arbitrary local executables with the Pi process's permissions.

Wire the seventh package through every repository authority:

- root `package.json` ordered `pi.extensions`;
- tracked `.pi/settings.json` signed workspace/Git override lists, enabling the workspace LSP entry and disabling the inherited Git copy;
- tracked `.pi/settings.json` `lsp.servers.typescript` using `pnpm exec tsc --lsp --stdio` and this repository's TypeScript/TSX mappings/root markers;
- root README package table, selectable paths, prerequisites, and focused check examples;
- `test/extension-entrypoints.test.ts` expected path/count;
- `test/project-extension-overrides.test.ts` expected count;
- `scripts/check-package-packs.mjs` workspace count and message;
- `scripts/check-git-install.mjs` extension count and message;
- `docs/releases.md`: five scoped packages bootstrap manually at `0.1.0`, and seven packages use trusted publishing afterward;
- `pnpm-lock.yaml`.

Retain the approved context and ADR wording. Format `CONTEXT-MAP.md` after the package row is present. Add no initial Changeset; confirm that policy in the updated release document.

Run:

```bash
pnpm format
pnpm --filter @ian-pascoe/pi-lsp typecheck
pnpm --filter @ian-pascoe/pi-lsp test
pnpm test:load
pnpm pack:check
pnpm git-install:check
pnpm changeset:status
```

**Complete when:** the workspace and packed tarball both load the seventh entrypoint, tracked project settings select exactly the intended workspace/Git copies, the package README covers every caller-visible contract, production install resolves both runtime dependencies, and Changeset status contains no bootstrap entry for `@ian-pascoe/pi-lsp`.

### 9. Run the proof gate

Run in order:

```bash
pnpm format
pnpm verify
pnpm changeset:status
git diff --check
git status --short
```

Inspect the final diff and confirm:

- all agreed operations exist exactly once in the discriminated union;
- settings contain no `maxDiagnostics`, transport switch, built-in catalog, or server-download behavior;
- the package contains no DAP, tree-sitter, formatter/analyzer subsystem, raw protocol-request tool, custom approval store, reload command, widget, or setup skill;
- every file-mutating path routes through Workspace Edit Preview → Validated Workspace Edit or a documented Supported Mutation Tool adapter;
- tool-result augmentation never replaces native/custom edit implementations;
- every child process, JSON-RPC connection, timer, listener, stream, and temporary write handle has a lifecycle owner and shutdown path;
- no source file named only `config`, `types`, `utils`, `helpers`, or `handlers` entered the package;
- package files, root metadata, project overrides, release counts, documentation, lockfile, and tests all agree on seven packages;
- the only working-tree changes are the package, its approved docs/ADRs, this plan, and required root integration.

**Complete when:** `pnpm verify` is green, the real TypeScript 7 LSP integration is green, pack/Git-install checks load the new source entrypoint, every checklist item is evidenced in the diff/tests, and no publish command has run.

## Pause

Implementation begins only in a later turn. This turn ends after the plan is written and reviewed.
