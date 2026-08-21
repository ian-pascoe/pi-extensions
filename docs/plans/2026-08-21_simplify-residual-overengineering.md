# Simplify residual over-engineering

**Status:** Awaiting approval

## Outcome

Apply every cut from the second repository-wide Ponytail audit while preserving extension behavior, persisted protocols, Pi lifecycle contracts, package loading, and the installed anti-slop policy. The expected result is roughly 770 fewer tracked lines and removal of three development dependencies (`zod`, `proper-lockfile`, `@types/proper-lockfile`).

Read before implementation:

- [`../../AGENTS.md`](../../AGENTS.md)
- [`../agents/domain.md`](../agents/domain.md)
- [`../../CONTEXT-MAP.md`](../../CONTEXT-MAP.md)
- [`2026-08-16_simplify-audited-overengineering.md`](2026-08-16_simplify-audited-overengineering.md) — this plan supersedes its step 4 decision (proper-lockfile); all other retained seams remain retained
- every affected package `CONTEXT.md`

This plan changes one user-visible source-data contract: bible translation records stop carrying the undocumented `staticEmbeddingAllowed` field. Add a minor Changeset for `@ian-pascoe/pi-bible-verses`. Removing runtime dependencies from `@ian-pascoe/pi-adaptive-thinking` and `pi-byterover` changes their published manifests: add one patch Changeset per package. All remaining work is behavior-preserving internal simplification and needs no Changeset or ADR.

## Boundaries

- Preserve every package's rendered output, tool schemas, settings parsing outcomes, notification text, and persisted/transcript compatibility.
- Preserve the narrow host-interface DI seams repo-wide (they carry real test fakes), including the TPS tokenizer loader/runtime seams and ByteRover's extension host. Where a step below replaces a one-method effects interface, the replacement constructor parameter keeps the seam injectable — update the fake, never delete it.
- Retain `CleanupGitCheckpointStoresInput.now` / `isProcessAlive` knobs (cheap fault seams with test investment).
- Retain the two identical anti-slop trees as the intentional installer payload/deployed copy.
- The Adaptive Thinking lock replacement must stay asynchronous: no synchronous busy-wait, no event-loop blocking. That constraint motivated the original proper-lockfile adoption and outlives it.
- Do not add generalized helpers, configuration switches, compatibility layers, or new abstractions beyond what a step explicitly names. A shared helper may be extracted only when a step names the exact call sites being unified.
- Every deleted symbol takes its test assertions with it in the same step.
- A deletion that cannot retain its stated behavior and focused checks stops for review rather than widening the change.

## Coverage ledger

| Area                | Confirmed cuts                                                                                                                                                                                                                                                              | Step |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---: |
| pi-lsp              | Schema-derived types; read-result dispatch; post-edit wrapper collapse; stderr buffering; budget scaffolding; test-only getters; unused hash/enabled flag; single-impl interfaces; shared splitters; dead fields                                                            |    2 |
| pi-dap              | Conditional-spread session states; settings merge generic; unusable output-buffer seam; duplicated process/env/pause logic; tool-input spreads; dead getters/options/params/fields; `_tag`s; double clone                                                                   |    3 |
| pi-git-checkpoints  | Unread navigation direction/expired-reason/start-tree/undo-record/skipped-paths machinery; per-capture branch subprocess; `_tag`                                                                                                                                            |    4 |
| Minimal Subagents   | Fork-recovery loop unification; unavailable-agent builder; outcome-collector inline; duplicate guards/reset; collapsed `availableTools`; unwritten `deleted` flag; tuple-derived union; shared path/status helpers; twin result arrays; branded `TurnId`; write-only fields |    5 |
| pi-codemode         | Shared usage merge; presentation-snapshot builder; single prefix algorithm; shared duration/clamp helpers; conditional spreads; unbranded session id; micro-deletions                                                                                                       |    6 |
| Small packages      | Native exclusive-create lock; TypeBox config schema; formatter closure; imported `JsonValue`; removed translation field and test-only export; deduplicated regex/guard/delegation shims                                                                                     |    7 |
| Root infrastructure | Plain process-error shape; hoisted manifest assertion; redundant production-install check                                                                                                                                                                                   |    8 |

Every ledger row is required.

## Implementation sequence

### 1. Establish the green baseline

Record:

```bash
git status --short
git rev-parse HEAD
pnpm verify
```

Record the passing test counts per package. Work on a clean tree; keep any later working-tree changes inside this implementation's diff.

**Complete when:** starting commit, working-tree state, green verification, and per-package test counts are recorded before source edits.

### 2. pi-lsp dead weight and duplication

Update `packages/pi-lsp/src/lsp-workspace-edit.ts`:

- Replace the hand-written `FileSnapshot`, `NormalizedWorkspaceOperation`, and `LspWorkspaceEditPreview` types with `Static<typeof ...>` of the corresponding schemas from `lsp-tool-contract.ts`.
- Delete the `hash` field and `hashContents()`; snapshots are compared by full JSON equality already.
- Delete `_tag` from the error class; discrimination is `instanceof`.
- Delete the `accepted` counter from `LspWorkspaceEditReplayResult` if only `.rejected` is read after re-verifying callers.
- Inline the `mutablePreview()` wrapper as a direct `structuredClone`.
- Share one line-splitting helper with `lsp-position-encoding.ts` and `lsp-server-client.ts` (place it in `lsp-position-encoding.ts`).

Update `packages/pi-lsp/src/lsp-tool.ts`:

- Collapse the five copy-pasted read-result blocks into one `readOutput(result)` helper dispatched from the executor cases.
- Inline `requestDocumentMethod` at its single caller.
- Replace the `ReturnType<...> extends Promise<infer T> ? T : never` return type with the direct promised result type.
- Delete the `recovery_failure_paths` details field (byte-identical to `changed_paths` at its only write site).

Update `packages/pi-lsp/src/lsp-post-edit-diagnostics.ts`:

- Delete the `PostEditToolResult` interface; take `ToolResultEvent` directly in the one remaining function.
- Delete the `PostEditDiagnosticsRunner` interface; accept `(paths) => Promise<outcomes[]>` directly. Update the production binding and the test fake to pass functions.

Update `packages/pi-lsp/src/lsp-session-files.ts`: delete `appendServerStderr`, `MAX_SERVER_STDERR_BYTES`, and the stderr content buffering; production capture lives entirely in `LspServerClient.appendTail`. Delete the covering test block.

Update `packages/pi-lsp/src/lsp-server-client.ts`:

- Rebuild `sendRequestWithBudget` on the shared `raceBudget` core instead of re-implementing timeout/abort/race scaffolding.
- Delete the test-only getters `processId`, `isRunning`, `serverInfo`, `recentProtocolMessages` and their assertions.
- Delete `diagnosticsRefreshRevision` (incremented, never read), the `LspSynchronizedDocument.filePath` field, `_tag`, and the redundant `cause instanceof Error &&` half of the cancellation check where the other operand already implies it.
- Inline `firstDiagnosticResult` at its single caller.
- Derive `LspServerClientTimeouts` from `LspTimeouts` (`Static` or spread) rather than re-declaring the shape.

Update `packages/pi-lsp/src/pi-lsp-settings.ts` and `lsp-server-manager.ts`: delete the `enabled` flag end-to-end. First confirm the settings reader tolerates stale `enabled` keys in existing user settings files; if parsing rejects unknown keys, keep the schema member as an accepted-but-ignored field and delete only the guard and status plumbing.

Update `packages/pi-lsp/src/lsp-server-manager.ts`: delete `LspServerFailure.rootPath` (set in four places, read nowhere); make `routeFile` private.

Update `packages/pi-lsp/src/pi-lsp-extension.ts`: extract the truncate/spill/notice logic shared by `appendSessionPostEditDiagnostics` and `createLspToolOutput` into one helper.

Update `packages/pi-lsp/src/lsp-tool-contract.ts`: delete the unused `WorkspaceEditPreviewDetails` / `WorkspaceEditApplyDetails` aliases.

Share one `pluralizedCount` helper between the two renderers instead of duplicating it.

Run:

```bash
pnpm --filter @ian-pascoe/pi-lsp typecheck
pnpm --filter @ian-pascoe/pi-lsp test
pnpm test:load
```

**Complete when:** every listed symbol is absent, the workspace-edit types are schema-derived, both post-edit interfaces are gone, the settings reader's treatment of stale `enabled` keys is confirmed and encoded in the chosen deletion depth, and the package's tests pass with only deleted-symbol assertions removed.

### 3. pi-dap combinatorics and dead options

Update `packages/pi-dap/src/dap-session.ts`:

- Rewrite the terminated/stopped state construction as conditional spreads (`...(exitCode !== undefined && { exitCode })`) and inline the single-caller `terminatedDapSessionState()` helper.
- Parameterize `pause()` through the `executeStoppedRequest` wait/request/cancel skeleton instead of duplicating it.
- Deduplicate the Linux `-pid` group kill between `stopOwnedDebuggeeProcess()` here and `signalOwnedProcessGroup()` in `dap-protocol-client.ts` (one exported helper in `dap-protocol-client.ts`), and reuse git-checkpoints' `processIsAlive` shape via one shared local helper rather than a second copy.
- Reuse `resolvedAdapterEnvironment()` in `spawnRunInTerminal` instead of the hand-rolled env-merge loop.
- Delete `_tag`, the dead `stop(_signal?)` parameter, the duplicate `this.shuttingDown = true` assignment in `performShutdown`, and the `const response = …; return response` indirection in `sendBreakpoints`.

Update `packages/pi-dap/src/dap-protocol-client.ts`:

- Delete the `adapterPid` and `isClosed` getters and their two tests.
- Delete the never-supplied `predicate` option from `DapProtocolEventWaitOptions`.

Update `packages/pi-dap/src/pi-dap-settings.ts`:

- Replace `mergeDapAdapters`/`mergeDapProfiles` with one generic `mergeValidLayer<T>(global, project)`.
- Delete the unread `scope` field on the valid `ParsedDapAdapter` variant (`profile.scope` stays — it feeds warnings).
- Drop one of the two `structuredClone(profile.arguments)` calls (resolve-time or launch-time, whichever leaves the parsed settings unshared).

Update `packages/pi-dap/src/dap-session-files.ts`: delete the `DapOutputBuffer` interface and `createDapOutputBuffer()` factory; `RetainedDapOutput` is the only implementation and `DapSessionOptions` has no injection point for the seam. Export or directly construct the class.

Update `packages/pi-dap/src/dap-tool.ts`:

- Build operation inputs with conditional-spread object literals (one expression per case) in `dispatchDapOperation`.
- Inline `registerDapTool()` at its single caller.

Replace `PiDapLifecycleEffects` with a `getAgentDirectory: () => string` constructor parameter; move the production implementation to the construction site and point the test fake at the parameter. Keep the seam injectable.

Run:

```bash
pnpm --filter @ian-pascoe/pi-dap typecheck
pnpm --filter @ian-pascoe/pi-dap test
```

**Complete when:** no byte-identical sibling functions remain, the deleted getters/options/fields/tags are absent including their assertions, the lifecycle effects interface is replaced by the injectable function parameter with tests still faking it, and the package's tests pass unchanged otherwise.

### 4. pi-git-checkpoints unread machinery

Update `packages/pi-git-checkpoints/src/git-checkpoint-history.ts`:

- Delete `navigationDirection()`, the `direction` field, and `GitCheckpointNavigationDirection`.
- Delete the `availableTreeIds` input and the `"target-checkpoint-expired"` plan reason; the extension never supplies the input, so the branch is unreachable.
- Delete `startTreeId` from `ModelStepCheckpoint`.

Update `packages/pi-git-checkpoints/src/git-checkpoint-store.ts`:

- Delete `branch` from `GitCheckpointSourceHead` and drop the extra `git symbolic-ref` subprocess from every capture.
- Delete the `record` field from the undo-inspection `"ready"` variant (the extension reads `divergedPaths` only).
- Delete `skippedPaths` from `RestoreWorktreeCheckpointResult` (`afterTree` reads `restoredPaths` only).
- Delete `_tag` from `GitCheckpointStoreError`.
- Retain the `now` / `isProcessAlive` knobs per Boundaries.

Delete the assertions exercising each removed symbol; keep the surrounding behavioral tests.

Run:

```bash
pnpm --filter @ian-pascoe/pi-git-checkpoints typecheck
pnpm --filter @ian-pascoe/pi-git-checkpoints test
```

**Complete when:** captures issue one fewer subprocess, the five unread fields/types/reasons are gone with their assertions, and remaining tests pass unchanged.

### 5. Minimal Subagents duplication sweep

Update `packages/pi-minimal-subagents/src/minimal-subagents-extension.ts`:

- Merge `cloneSelectedForkSessions` and `bindForkSnapshotToDestination` into one parameterized helper taking the per-session operation; the failedSubtrees/notify/push skeleton exists once.
- Replace the local unavailable-agent construction with the shared helper from the next bullet.

Update `packages/pi-minimal-subagents/src/minimal-subagents-coordinator.ts`:

- Extract one `unavailableAgent(agent, error)` helper used by both `createForkPlaceholder` and the extension site.
- Delete the second of the two byte-identical consecutive guard blocks in `deliverAutomaticResult`.
- Collapse `restore()`'s double reset (three `createDeliveryLedger()` calls plus clear loops) into one reset pass.
- Delete `tombstoned_agent_ids` from `DeleteResult` and its render section (always identical to `deleted_agent_ids`).
- Stop populating the write-only `AgentSummary.latest_activity`.
- Replace the branded `TurnId` with plain `string`, removing the SAFETY cast at `beginTurn`.

Update `packages/pi-minimal-subagents/src/minimal-subagents-sessions.ts`: inline `ChildTurnOutcomeCollector` as a local closure inside `captureChildTurnOutcome` and drop the export; share the path-canonicalization helper with `minimal-subagents-fork-lifecycle.ts` (one definition, one importer).

Update `packages/pi-minimal-subagents/src/minimal-subagents-types.ts`:

- Collapse `availableTools` into `capabilityCeiling` (identical at every production site); update the one diverging test to use the surviving field.
- Delete `PersistedAgent.deleted?` and its three rejection branches in `minimal-subagents-registry.ts` (never written true).

Update `packages/pi-minimal-subagents/src/minimal-subagents-render-contract.ts`: derive `CoordinatorToolName` as `(typeof COORDINATOR_TOOL_NAMES)[number]`.

Update `packages/pi-minimal-subagents/src/minimal-subagents-rendering.ts` and `minimal-subagents-ui.ts`: keep one unavailable→running→latest_turn→idle status ladder (exported from rendering) and consume it from the UI; index `subagentStatusPresentation` by direct record lookup with an idle fallback instead of an `Object.entries` scan.

Run:

```bash
pnpm --filter @ian-pascoe/pi-minimal-subagents typecheck
pnpm --filter @ian-pascoe/pi-minimal-subagents test
```

**Complete when:** each skeleton/builder/ladder/helper exists once, the deleted fields and branches are gone with their assertions, transcript and replay tests pass unchanged, and no new abstraction exists beyond the four named shared helpers.

### 6. pi-codemode shared helpers and spreads

Update `packages/pi-codemode/src/codemode-session-coordinator.ts`, `pi-tool-bridge.ts`, `codemode-observer-ui.ts`, and `codemode-tool-rendering.ts`:

- Keep one usage-merge implementation (extend `addUsage` or `combineCodeModeUsage`, whichever fits both call sites) and call it from the coordinator and the bridge.
- Build the two 12-field presentation snapshots through one shared builder parameterized by `cell_state`.
- Keep one shortest-unique-prefix implementation; have `formatSessionPrefix` and the observer's plural variant share it.
- Keep one duration formatter and one elapsed-clamp helper; delete the byte-identical copies.
- Replace `let x = {}; if (v !== undefined) x = { ...x, k: v }` chains with conditional-spread literals in `observeSession`, `replaceWithTerminal`, `createActiveCell`, and the extension's `Object.assign` chains.
- Replace the branded `CodeModeSessionId` with plain `string`, removing the SAFETY cast at its creation site.

Update `packages/pi-codemode/src/codemode-observer-ui.ts`: inline `joinCodeModeObserverRow` as a direct `.join`; delete the dead `shutdown(_reason)` parameter where declared.

Update `packages/pi-codemode/src/codemode-tool-catalog.ts`: inline `jsonLiteral` as direct `JSON.stringify` calls.

Update `packages/pi-codemode/src/codemode-worker-protocol.ts`: replace the hand-rolled `hasExactKeys` scan with a length check plus `every(has)`.

Run:

```bash
pnpm --filter @ian-pascoe/pi-codemode typecheck
pnpm --filter @ian-pascoe/pi-codemode test
```

**Complete when:** each duplicated algorithm/formatter exists once, the brand and micro-wrappers are gone, rendering tests assert identical output, and the worker smoke test passes.

### 7. Small packages: native replacements and field sweeps

#### pi-adaptive-thinking

Update `src/adaptive-thinking-lifecycle.ts`:

- Delete the `proper-lockfile` import. Implement the settings lock with `fs.open(path, "wx")` exclusive-create plus an asynchronous bounded retry loop preserving the current bound (99 retries after the first attempt, 20 ms fixed delay); release by unlinking the lock target in `finally`. No synchronous sleeping.
- Collapse the default-export adapter's `registerTool` if/else to the direct `pi.registerTool(tool)` call; keep the type guards (tests use them as predicates).

Update `package.json`: remove `proper-lockfile` and `@types/proper-lockfile`. Update `src/config.ts`: delete the `parseConfig` export; retarget its test at `parseAdaptiveThinkingConfig(input).config`. Strengthen the existing contention test to prove timer-driven retry completes without blocking.

#### pi-byterover

Update `src/config.ts`: port the ConfigSchema from `zod/v4` to `typebox` (already a peerDep) preserving validation outcomes and every error message the tests assert. Update `package.json`: remove `zod`. Update `src/gitignore.ts` and `src/recall.ts`: keep one `escapeRegExp` (export from `gitignore.ts`). Update `src/tools.ts`: delete the duplicate `config.manualTools` guard inside `registerManualTools` and inline the three `errorMessage` wrappers as `.message`. Update `src/byterover-lifecycle.ts`: replace the three-arm registerTool switch with a direct `(tool) => pi.registerTool(tool)` hand-off.

#### pi-formatter

Update `src/pi-formatter-settings.ts`: import `JsonValue` from `@earendil-works/pi-ai` (matching sibling packages) and delete the hand-rolled recursive type. Update `src/pi-formatter-extension.ts`: replace `PiFormatterLifecycleController` + effects interface + module-level instance with a closure registering the same two handlers against the same settings field; keep the exported `createPiFormatterExtension` signature identical.

#### pi-bible-verses

Update `src/bible-translations.ts`: delete `staticEmbeddingAllowed` from the record type and all seven translation records; keep every license/provenance field. Update fixtures in `test/bible-translations.test.ts`. Add the minor Changeset naming the removed field.

Add the two dependency-removal patch Changesets (pi-adaptive-thinking, pi-byterover).

Run:

```bash
pnpm --filter @ian-pascoe/pi-adaptive-thinking typecheck && pnpm --filter @ian-pascoe/pi-adaptive-thinking test
pnpm --filter pi-byterover typecheck && pnpm --filter pi-byterover test
pnpm --filter @ian-pascoe/pi-formatter typecheck && pnpm --filter @ian-pascoe/pi-formatter test
pnpm --filter @ian-pascoe/pi-bible-verses typecheck && pnpm --filter @ian-pascoe/pi-bible-verses test
```

**Complete when:** `proper-lockfile` and `zod` appear nowhere under `packages/`, the lock retries asynchronously within the preserved bound, byterover config validation errors match the pre-port assertions, the formatter registers identical handlers through a closure, translation records carry no `staticEmbeddingAllowed`, and exactly three Changesets exist (one minor, two patch).

### 8. Root scripts

Update `scripts/node-process-error.mjs`: return `{ code?, stderr? } | null` instead of kind-tagged wrappers; simplify both callers to `pe?.code === "ENOENT"` and `pe?.stderr ?? ""` with identical behavior.

Update `scripts/check-package-packs.mjs`: hoist the `scripts.build` assertion above a plain forbidden-field loop over `["main", "types", "exports"]`.

Update `scripts/prepare.mjs`: delete the legacy `npm_config_production === "true"` string check; the `npm_config_omit` set check covers npm≥7 and pnpm.

Run:

```bash
pnpm pack:check && pnpm git-install:check
```

**Complete when:** both check scripts pass against a packed fixture and no kind-tagged error shape remains.

### 9. Full verification

Run:

```bash
pnpm verify
pnpm changeset:status
```

Confirm the three Changesets from step 7 are the only additions, `rg -n "proper-lockfile|zod" packages/` returns nothing outside lockfiles, and per-package test counts differ from the step 1 baseline only by deleted-symbol assertions.

**Complete when:** the full verification is green, the dependency greps are clean, and the diff contains no file outside the steps above.
