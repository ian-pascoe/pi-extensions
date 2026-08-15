# Migrate all anti-slop findings without weakening the rules

**Status:** Awaiting approval

## Outcome

Reduce the current anti-slop baseline from **391 errors in 40 files to zero**, repair the stale root settings-contract test, and restore a fully green `pnpm verify` while preserving package behavior, public extension entrypoints, Registry compatibility, and the installed lint policy.

The migration follows three construction rules:

1. **Parse at ingress:** serialized, framework, and third-party values enter owned code through a schema or owner parser, then remain precisely typed.
2. **Keep evidence:** inferred values retain their precise types through `satisfies`, named contracts, and discriminated unions.
3. **Test through seams:** tests use real interfaces with recording or faithful adapters; module replacement and private-state access become observable behavior checks.

Read before implementation:

- [`../../AGENTS.md`](../../AGENTS.md)
- [`../agents/domain.md`](../agents/domain.md)
- [`../../CONTEXT-MAP.md`](../../CONTEXT-MAP.md)
- both repository ADRs in [`../adr/`](../adr/)
- every affected package `CONTEXT.md`
- all four Minimal Subagents ADRs in [`../../packages/pi-minimal-subagents/docs/adr/`](../../packages/pi-minimal-subagents/docs/adr/)
- [`../../.oxlintrc.json`](../../.oxlintrc.json)
- the vendored rule implementations in [`../../tools/oxlint/anti-slop/`](../../tools/oxlint/anti-slop/)

This is a reversible type-boundary and testability migration. It changes no domain term or architectural decision, so it requires no ADR, glossary edit, README change, or Changeset. If implementation would expose a new published interface or change behavior, stop for separate approval.

## Boundaries and proof obligations

- Preserve all 15 anti-slop rules at `"error"`, the JavaScript plugin registration, and the current ignore list. Preserve the vendored plugin byte-for-byte.
- Preserve the pre-existing `.pi/settings.json` modification byte-for-byte. Treat its workspace-plus-Git package layout as the current repository configuration contract and repair the stale test around it.
- Preserve error messages, configuration precedence, tool names and schemas, transcript/TUI output, process-global fork handoff, Registry V1 migration, Registry V2 diagnostics, Delivery Ledger ordering, and Delivery Evidence semantics.
- Use TypeBox in packages that already use TypeBox, Zod in ByteRover, and Pi SDK discriminated types when the framework has already parsed the value.
- Give every new seam a production adapter and a faithful test adapter. Keep internal modules real when an external seam is unnecessary.
- Eliminate a type assertion by parsing, branching, inference, or a precise owner contract first. Retain an assertion only for an interop invariant TypeScript cannot express; its `SAFETY:` comment must name the runtime check and the focused test that proves it.
- Construct malformed test data at the wire/JSON boundary rather than corrupting an application type.
- Build optional object fields in statements so exact optional-property semantics remain visible.
- Keep current green rules green: `no-object-parameters`, `no-reflect-apply`, `no-shape-in-symbol-names`, `no-unknown-type-aliases`, and `no-widen-then-assert` currently report zero findings.

## Baseline

### Findings by area

| Area                   | Findings |  Files |
| ---------------------- | -------: | -----: |
| Minimal Subagents      |      253 |     19 |
| ByteRover              |       56 |      9 |
| Adaptive Thinking      |       42 |      4 |
| TPS Tracker            |       17 |      2 |
| Git Status Widget      |        9 |      1 |
| Bible Verses           |        4 |      1 |
| Root scripts and tests |       10 |      4 |
| **Total**              |  **391** | **40** |

### Findings by rule

| Rule                                        | Findings |
| ------------------------------------------- | -------: |
| `require-safety-comment-for-type-assertion` |      138 |
| `no-runtime-typeof`                         |       72 |
| `no-unknown-parameters`                     |       71 |
| `no-known-value-widening`                   |       39 |
| `no-unsafe-dictionary-type`                 |       36 |
| `no-module-mocking`                         |       13 |
| `no-chained-type-assertions`                |       10 |
| `no-conditional-empty-object-spread`        |        7 |
| `no-unknown-returns`                        |        4 |
| `no-reflect-get`                            |        1 |
| **Total**                                   |  **391** |

Current behavioral baseline:

- `pnpm format:check` passes.
- `pnpm typecheck` passes.
- `pnpm turbo test` passes all **214 package tests**.
- `pnpm test` has one pre-existing root failure in `test/project-extension-overrides.test.ts`: the test still expects the five npm override entries removed from the tracked settings contract, while the current `.pi/settings.json` selects between the workspace and the whole-collection Git source. Step 7 owns this stale test and must make the full root suite green without editing `.pi/settings.json`.

## Implementation sequence

### 1. Lock the red baseline and lint-policy evidence

Before source edits:

1. Record `git status --short` and preserve every existing modification and untracked installation file.
2. Run Oxlint with JSON output and save the 391-diagnostic inventory outside the repository.
3. Record SHA-256 for `.oxlintrc.json` and every file under `tools/oxlint/anti-slop/`.
4. Record the passing format, typecheck, and package-test baselines plus the root-test failure assigned to Step 7.
5. Add `fast-check` as a root development dependency for the Registry parser property test in Step 2; make no package runtime dependency change.

After every wave, lint every changed owned TypeScript/JavaScript file, run the affected package typecheck and tests, and compare the remaining global diagnostic count with the wave target.

**Complete when:** the lint-policy hashes, 391-finding JSON inventory, behavioral baseline, and pre-existing working-tree state are reproducible before implementation begins.

### 2. Parse Minimal Subagents settings, Registry, and session records

This wave owns **122 findings**:

- `minimal-subagents-config.ts`: 17;
- `minimal-subagents-context.ts`: 2;
- `minimal-subagents-registry.ts`: 77;
- `minimal-subagents-sessions.ts`: 26.

#### Settings

Replace the local `unknown`/dictionary inspection in `minimal-subagents-config.ts` with a package-owned JSON settings representation and focused TypeBox schemas for:

- the `minimalSubagents` settings object;
- `maxSubagentDepth`;
- shorthand and expanded Model Roles;
- global/project deletion and merge values.

Type the settings reader from Pi's `Settings` owner contract, adding a narrow module augmentation for `minimalSubagents` if needed. Represent arbitrary JSON as Pi's recursive `JsonValue`, not `Record<string, unknown>`. Structural parsing produces scoped settings values; existing functions retain semantic warning ownership, project-over-global merge rules, exact-model-first suffix handling, role deletion, and `null` reset behavior.

Use non-coercive schema checks and preserve the current warning text and order, including merge-before-final-validation behavior. Build `MinimalSubagentsModelRole` fields imperatively after validation so `thinkingLevel` and `hint` are present only when defined.

#### Imported context

Give `assembleImportedContext` a named `ImportedSubagentContext` return contract. Keep `messages` and `compact` behavior unchanged and let inference preserve each returned literal.

#### Registry

Split the Registry boundary into structural parsing and semantic validation:

- Add a focused Registry wire-schema module for V1/V2 envelopes, Usage, Launch Contracts, persisted agents, terminal deliveries, Coordination Deliveries, claims, checkpoints, and event-specific payloads.
- Derive wire types from the schemas and translate them field-by-field into the existing application types.
- Replace optional-field clusters in `ParsedRegistryEvent` and snapshot validation with discriminated outcomes such as `event`, `foreign-root`, and `invalid`.
- Preserve the current `createRegistryEvent(root, event, data, timestamp?)` interface. Implement it with a discriminated rest-tuple argument union and an exhaustive event switch so each `RegistryEventV2` member is constructed directly without chained assertions; normalize checkpoint ledgers only in the checkpoint branch.
- Give snapshot validation a named result union, eliminating the 30 anonymous-return widening findings while preserving every stable diagnostic code and message.
- Keep semantic checks after structural parse: canonical hierarchy, selected leaves, identity ownership, adjacency, sequence uniqueness/high-water marks, wait-claim observability, retention limits, and V1-to-V2 normalization.
- Build `RegistrySnapshot` explicitly after all fields pass; do not clone an unparsed record into the application type.

Use TypeBox `Value.Check` rather than coercion, cleaning, conversion, or defaults at Registry/session replay boundaries. Permit additional properties where the current parser tolerates them so the migration does not silently tighten the persisted protocol.

Add a `fast-check` property test that feeds arbitrary JSON values to the Registry boundary and proves parsing never throws. Retain the existing focused tests for every diagnostic and migration invariant.

#### Child session records and Delivery Evidence

Create focused TypeBox schemas for child identity, fork provenance, and fork ownership custom-entry data. Make the latest-record lookup generic over a schema so `SessionEntry.data` is parsed by the schema library rather than by local `unknown` predicates.

Type `findDeliveryEvidence` from Pi's `SessionEntry` union. Parse only custom-message/tool-result `details` through a Delivery Evidence schema, then compare typed source, turn, message, and delivery identities. Use the SDK's entry/message discriminants for the surrounding protocol.

Replace the auth-header `typeof` filter with a typed null check over its owner-provided `string | null` value. Keep `captureChildTurnOutcome` on the SDK's `AgentSessionEvent` contract.

**Complete when:** these four files report 122 → 0 anti-slop findings; Registry replay still passes all V1/V2, branch, corruption, identity, adjacency, retention, and sequence tests; arbitrary JSON cannot throw; session identity, fork ownership, Delivery Evidence, and compact-context tests remain green.

### 3. Carry typed coordinator, tool, status, and rendering contracts

This wave owns the remaining **59 Minimal Subagents production findings**.

#### Owner contracts

- Change `AgentDetail.launch_contract` from a broad dictionary to `LaunchContract`; clone it directly in the coordinator.
- Define schema-derived argument types and named result-detail contracts for each of the six coordinator tools.
- Make `structuredToolResult<TDetails>` preserve its detail type in `AgentToolResult<TDetails>`.
- Give the UI a hierarchy-status reader interface and give tool execution the smallest coordinator-operation interface it actually consumes.
- Keep current/legacy transcript DTOs separate from Registry application types.

#### Rendering ingress

Add a focused render-contract module with TypeBox schemas for tool details, status results, Wait Events, cancel/delete results, Coordinator Messages, legacy message fields, and Usage. `renderCoordinatorToolResult` selects the schema by tool name, parses once, and uses the existing text fallback for malformed historical details.

Then:

- remove the `asRecord`/`asString`/`asStringArray`/`asNumber` family;
- read Usage through its owner type;
- type message content from Pi's text/image union;
- separate text-section and component-section append operations;
- make preview helpers accept `string | undefined`;
- type call/result renderers per tool instead of erasing correlation into broad dictionaries;
- validate status-presentation and renderer tables with inferred literals plus `satisfies`;
- give direct-status counts a named return type;
- preserve every current collapsed, expanded, error, malformed, and legacy rendering path.

#### Small production fixes

- Rename genuine Promise rejection inputs to `cause` and keep error-cause formatting local.
- Remove both redundant `SessionEntry[]` assertions: the SDK already returns that type.
- Replace the fork-snapshot `globalThis` assertion with a typed `declare global` package-owned property while preserving canonical-key lookup and consume-once behavior.
- Destructure the first eligible model before `StringEnum` so the non-empty tuple is established without assertion.
- Construct `SpawnParameters` and optional spawn status details explicitly rather than asserting schema output or conditionally spreading `{}`.

Add focused rendering tests for all current DTOs, legacy fields, malformed fallback, text/image content, Usage, presentation fallback, and partial/error output.

**Complete when:** all seven affected production files report 59 → 0 findings; all tool schemas and names are unchanged; Runtime Profile/Launch Contract behavior is unchanged; transcript and TUI snapshots remain equivalent.

### 4. Replace Minimal Subagents test shortcuts with real interfaces

This wave owns **72 findings in eight Minimal Subagents test files**, including 11 module mocks.

Add cohesive test support under `packages/pi-minimal-subagents/test/support/` only where reused:

- typed Agent Message and image-message constructors;
- plain transcript/widget themes satisfying narrow rendering theme contracts;
- a recording Root Conversation Endpoint and typed Registry event recorder;
- complete coordinator/session dependencies satisfying their production interfaces;
- typed extension lifecycle emitters;
- a faithful session-file trash adapter.

Make two earned production seams:

1. A Minimal Subagents extension lifecycle controller that owns coordinator/UI/prepared-fork state and accepts only true SDK/runtime construction effects. Keep config, Registry, rendering, tools, and shutdown implementations real in lifecycle tests.
2. A session-file trash capability used by `PiAgentSessionFactory`; production wraps `execFile("trash", ...)`, while tests provide unavailable and successful adapters. Preserve identity verification, leading-dash handling, and unlink fallback.

Rewrite tests as follows:

- `context.test.ts`: use complete typed user/assistant/image messages.
- `coordinator.test.ts`: type dependencies with `satisfies`, record `RegistryEventV2[]` and `CoordinatorMessage[]`, narrow Wait Events by discriminant, and replace `Reflect.get` with public proof that the Delivery Ledger is empty and repeated reconciliation does not redeliver.
- `extension.test.ts`: delete all ten `vi.mock` blocks; drive the lifecycle controller/default composition with real internal modules, temporary/in-memory Pi state, and recording external adapters. Retain renderer, six-tool, active-branch, tree, fork, process-loss, provenance-rejection, reconciliation, and awaited-shutdown coverage.
- `message-envelope.test.ts` and `ui.test.ts`: pass narrow themes/status/UI adapters directly.
- `registry.test.ts`: make custom-entry fixtures generic and inject invalid thinking data as JSON/wire input.
- `sessions.test.ts`: replace the child-process mock with the trash adapter, use SDK Agent Message/session event types, and provide a complete resource-loader fixture.
- `tools.test.ts`: use schema inference and typed tool-operation ports; exercise public definitions without fabricated full contexts.

Prefer recording adapters' public records over Vitest mock-call tuple casts. Remove every affected test's `as never`, assertion chain, and private property read rather than decorating it with a comment.

**Complete when:** the eight test files report 72 → 0 findings; `vi.mock`, `vi.doMock`, `Reflect.get`, `as unknown as`, and blanket `as never` are absent from the migrated Minimal Subagents tests; all 110 package tests remain green or are replaced by tests at a deeper real interface with equivalent behavioral coverage.

### 5. Migrate Adaptive Thinking

This wave owns **42 findings in four files**.

#### Configuration and settings files

- Define an optional-override TypeBox schema for raw Adaptive Thinking configuration, parse before reading keys, and derive the input/output types from schemas.
- Detect `guidance`/deprecated `systemPrompt` ownership on the parsed input, then construct the normalized config field-by-field. Remove broad record spreads, deletion assertions, and the output assertion.
- Return deprecation metadata from the owning parse operation so the loader does not inspect raw JSON a second time.
- Use the allowed `cause` convention for error enrichment. Classify `ENOENT` with `cause instanceof Error`, property ownership, and equality rather than runtime representation checks.
- Build `LoadConfigResult` optional metadata in statements.
- Add a Pi settings-document schema that preserves every JSON property while parsing `defaultThinkingLevel`. Read and restore through the parsed document so unrelated settings survive byte-for-semantic-byte without broad dictionaries.

#### Typed extension harness

Replace the repeated `pi as never` calls with a package-owned narrow extension-host interface plus a recording adapter. Store handlers and registered tools in typed fields/records rather than heterogeneous `any` collections. Represent an unknown native level as the native string returned by the host seam and let `isThinkingLevel` normalize it; do not corrupt a `PiThinkingLevel` type.

Retain all current tests for Session Baseline, Temporary Thinking Level, locking/recovery, static prompt metadata, deprecated guidance, quiet notifications, and back-to-back tool behavior.

**Complete when:** Adaptive Thinking reports 42 → 0 findings; all 36 tests and package typecheck pass; configuration precedence, messages, and global-settings preservation are unchanged.

### 6. Migrate ByteRover

This wave owns **56 findings in nine files**.

#### Real ByteRover seam

Define a package-owned ByteRover bridge capability containing the `ready`, `recall`, `search`, and `persist` operations used by the extension, plus a factory accepting the existing override options. The production adapter constructs `BrvBridge`; tests use a faithful recording adapter. Compose the default extension with the production adapter and test the extension through the same factory seam. Delete the `@byterover/brv-bridge` module mock.

Type captured production configuration as `BrvBridgeConfig` and operation results with the bridge package's owner types. Keep the existing real CLI integration smoke.

#### Parsing and object construction

- Use Zod at ByteRover JSON configuration ingress; use `cause` for error enrichment and Error/property equality for `ENOENT`.
- Change message extraction to accept Pi `SessionEntry[]` and use SDK role/content discriminants. This removes the local record predicate and all four runtime `typeof` checks while preserving Untrusted Recalled Memory selection and formatting.
- Build recall/search option objects in statements so `signal`, `limit`, and trimmed `scope` are added only when present.
- Pass exactly `RegisterManualToolsInput`; remove the asserted extra logging/notification fields.
- Parse `byterover-cli/package.json` with a focused schema before resolving its `bin.brv` entry.

#### Typed tests

- Use `JsonValue` or config-input owner types for config-file helpers.
- Give deferred rejection the `cause` convention.
- Replace partial Pi/context casts with narrow recording extension-host and context contracts.
- Make tool-result text helpers generic over `AgentToolResult<TDetails>` and narrow content by its discriminant.
- Use precise bridge/config/search/persist types in fixtures; inspect recorded values directly.

Retain tests for configuration precedence, gitignore normalization, automatic Recall/Curation, deduplication, untrusted-context injection, quiet failures, manual tools, timeouts, and real CLI readiness.

**Complete when:** ByteRover reports 56 → 0 findings; no module mock remains; all 46 tests and package typecheck pass; Recall/Curation behavior and CLI integration remain unchanged.

### 7. Migrate TPS Tracker, small package harnesses, and root boundaries

This wave owns the final **40 findings**.

#### TPS Tracker — 17

- Use Pi's `MessageUpdateEvent` and `AssistantMessageEvent` discriminated unions directly; output deltas already carry strings and Usage already carries numbers. Remove the asserted local delta shape and `unknown` coercion helpers.
- Split the implementation into a typed tracker core, an injected clock, and an `OutputTokenCounterLoader`. The production adapter owns dynamic `import("tiktoken")`, parses `tiktoken/model_to_encoding.json`, resolves a known model to its encoding, and calls `get_encoding`; unknown models use `o200k_base`. This avoids asserting an arbitrary Pi model ID to tiktoken's closed `TiktokenModel` union.
- Tests inject available, unavailable, model-keyed, and recording tokenizer adapters instead of `vi.doMock`; include an unknown-model fallback test.
- Replace the partial Pi/context assertions with typed recording lifecycle and UI adapters.

Preserve Official Output Count → Tokenized Output Count → Estimated Output Count precedence, model-keyed caching, 250 ms status throttling, and per-message/agent resets.

#### Bible Verses and Git Status Widget — 13

- Load both extensions through Pi's real `discoverAndLoadExtensions`/extension-runner surface where practical, then use its typed handler map rather than fabricating `ExtensionAPI`.
- Type Bible lifecycle handlers with `TurnStartEvent`/`TurnEndEvent` and use a recording Working Message host; store each handler in its exact event slot.
- Type Git handlers with Pi's exact lifecycle event/result contracts. Replace mock-call extraction with a recording widget UI whose public state exposes the latest rendered line.
- Keep all real/fake Git process tests, polling replacement/disposal, detached state, count rendering, non-TUI behavior, and Working Message behavior unchanged.

#### Root scripts and tests — 10

- Add one searchable Node process-error helper shared by the pack/install scripts. It classifies `execFile` failures through Error instances and optional owned `stderr`/`code` properties, replacing all four runtime `typeof` checks without changing output or ENOENT handling.
- Parse package manifests and `.pi/settings.json` with focused TypeBox schemas before use.
- Normalize string/object package settings entries into one tagged owner representation so source/extension access needs no runtime type test.
- Preserve the existing extension order, package filtering, pack contents, and Git-install checks.
- Repair `test/project-extension-overrides.test.ts` around the configuration that actually exists, without rewriting `.pi/settings.json` to satisfy the old assertion:
  1. Derive all six extension paths and npm package identities from the root and workspace manifests rather than retaining the stale five-package constant.
  2. Parse the current settings and require exactly one workspace source and one `git:github.com/ian-pascoe/pi-extensions` source, both with `autoload: false`.
  3. For each source, require exactly one signed override for every authoritative extension path, reject unknown or duplicate paths, and require the two positive-selection sets to be disjoint. This validates configuration coherence while preserving the owner's current choice of enabled extensions.
  4. Move package-manager precedence behavior into a temporary, offline fixture: install all six fake inherited npm packages under the temporary agent directory, configure the temporary project with its workspace source, and prove workspace toggles are honored while inherited npm entrypoints are disabled. Do not make a network Git clone part of the unit test; `pnpm git-install:check` remains the real whole-collection Git loading proof.
  5. Keep the independent per-extension workspace-toggle test and update it to derive its expected enabled count from the manifest instead of hard-coding five.

**Complete when:** these eight files report 40 → 0 findings; TPS's eight, Git Status Widget's five, and Bible Verses' nine tests pass; both root test files typecheck and pass; the settings test proves the current two-source contract and package precedence without network access; `.pi/settings.json` is unchanged.

### 8. Run the proof gate

Run in order:

```bash
pnpm format
pnpm format:check
pnpm lint
pnpm typecheck
pnpm turbo test

pnpm test
pnpm pack:check
pnpm git-install:check
git diff --check
git status --short
```

`pnpm lint` must emit zero diagnostics across all 15 rules, not merely remove the original 391 lines. `pnpm test` and the complete `pnpm verify` gate must pass; the former settings-test exception is no longer permitted.

Compare the final `.oxlintrc.json` and vendored-plugin hashes with Step 1. Also run focused searches over owned changed files:

```bash
rg -n 'vi\.(doMock|mock)\(' packages test
rg -n 'as unknown as|Reflect\.get' packages test scripts
```

Every match introduced or touched by this migration must either be removed or be an approved, tested interop invariant outside the anti-slop rule set. Inspect the final diff for broad replacement contracts, public-surface growth, error-message drift, unrelated formatting, and changes to `.pi/settings.json`.

**Complete when:** lint-policy hashes match; all 391 original findings and every newly introduced finding are gone; `pnpm verify` passes in full; behavioral outputs, persistence compatibility, and the current `.pi/settings.json` bytes remain unchanged.

## Diagnostic coverage ledger

Abbreviations: `SC` safety comment, `RT` runtime `typeof`, `UP` unknown parameter, `KW` known-value widening, `UD` unsafe dictionary, `MM` module mock, `CA` chained assertion, `CE` conditional empty-object spread, `UR` unknown return, `RG` `Reflect.get`.

| File                                                                    | Findings | Rules                                 |
| ----------------------------------------------------------------------- | -------: | ------------------------------------- |
| `packages/pi-adaptive-thinking/src/config-loader.ts`                    |        5 | CE 1, RT 1, UP 3                      |
| `packages/pi-adaptive-thinking/src/config.ts`                           |       10 | KW 1, RT 1, SC 3, UD 2, UP 3          |
| `packages/pi-adaptive-thinking/src/index.ts`                            |        6 | RT 2, SC 2, UD 1, UP 1                |
| `packages/pi-adaptive-thinking/test/index.test.ts`                      |       21 | SC 21                                 |
| `packages/pi-bible-verses/test/extension.test.ts`                       |        4 | SC 2, UP 2                            |
| `packages/pi-byterover/src/config-loader.ts`                            |        4 | RT 1, UP 3                            |
| `packages/pi-byterover/src/gitignore.ts`                                |        2 | RT 1, UP 1                            |
| `packages/pi-byterover/src/index.ts`                                    |        2 | SC 1, UP 1                            |
| `packages/pi-byterover/src/messages.ts`                                 |        8 | RT 4, UD 1, UP 3                      |
| `packages/pi-byterover/src/tools.ts`                                    |        4 | CE 3, UP 1                            |
| `packages/pi-byterover/test/byterover-cli.integration.test.ts`          |        1 | SC 1                                  |
| `packages/pi-byterover/test/config-loader.test.ts`                      |        1 | UP 1                                  |
| `packages/pi-byterover/test/index.test.ts`                              |       23 | CA 2, MM 1, SC 14, UD 5, UP 1         |
| `packages/pi-byterover/test/tools.test.ts`                              |       11 | CA 1, SC 10                           |
| `packages/pi-git-status-widget/test/git-status-widget.test.ts`          |        9 | SC 6, UP 2, UR 1                      |
| `packages/pi-minimal-subagents/src/minimal-subagents-config.ts`         |       17 | CE 2, RT 5, UD 2, UP 6, UR 2          |
| `packages/pi-minimal-subagents/src/minimal-subagents-context.ts`        |        2 | KW 2                                  |
| `packages/pi-minimal-subagents/src/minimal-subagents-coordinator.ts`    |        4 | CA 1, UD 1, UP 2                      |
| `packages/pi-minimal-subagents/src/minimal-subagents-extension.ts`      |        2 | SC 2                                  |
| `packages/pi-minimal-subagents/src/minimal-subagents-fork-lifecycle.ts` |        1 | SC 1                                  |
| `packages/pi-minimal-subagents/src/minimal-subagents-registry.ts`       |       77 | CA 3, KW 30, RT 21, SC 1, UD 1, UP 21 |
| `packages/pi-minimal-subagents/src/minimal-subagents-rendering.ts`      |       44 | KW 5, RT 9, SC 4, UD 19, UP 7         |
| `packages/pi-minimal-subagents/src/minimal-subagents-sessions.ts`       |       26 | RT 19, SC 3, UP 4                     |
| `packages/pi-minimal-subagents/src/minimal-subagents-tool-schemas.ts`   |        1 | SC 1                                  |
| `packages/pi-minimal-subagents/src/minimal-subagents-tools.ts`          |        6 | CE 1, SC 1, UD 2, UP 2                |
| `packages/pi-minimal-subagents/src/minimal-subagents-types.ts`          |        1 | UD 1                                  |
| `packages/pi-minimal-subagents/test/context.test.ts`                    |        4 | SC 4                                  |
| `packages/pi-minimal-subagents/test/coordinator.test.ts`                |       15 | CA 3, RG 1, SC 10, UP 1               |
| `packages/pi-minimal-subagents/test/extension.test.ts`                  |       17 | KW 1, MM 10, SC 4, UP 2               |
| `packages/pi-minimal-subagents/test/message-envelope.test.ts`           |        2 | SC 2                                  |
| `packages/pi-minimal-subagents/test/registry.test.ts`                   |        2 | SC 1, UP 1                            |
| `packages/pi-minimal-subagents/test/sessions.test.ts`                   |       14 | MM 1, SC 12, UP 1                     |
| `packages/pi-minimal-subagents/test/tools.test.ts`                      |        8 | SC 8                                  |
| `packages/pi-minimal-subagents/test/ui.test.ts`                         |       10 | SC 10                                 |
| `packages/pi-tps-tracker/src/index.ts`                                  |        6 | RT 2, SC 2, UP 2                      |
| `packages/pi-tps-tracker/test/tps-tracker.test.ts`                      |       11 | MM 1, SC 8, UD 1, UR 1                |
| `scripts/check-git-install.mjs`                                         |        2 | RT 2                                  |
| `scripts/check-package-packs.mjs`                                       |        2 | RT 2                                  |
| `test/extension-entrypoints.test.ts`                                    |        1 | SC 1                                  |
| `test/project-extension-overrides.test.ts`                              |        5 | RT 2, SC 3                            |

The ledger totals **391** and is the completeness checklist for implementation review.

## Pause

Do not begin implementation until this revised plan is approved. The root settings-contract failure is now in scope; `.pi/settings.json` itself remains an immutable input to the repair.
