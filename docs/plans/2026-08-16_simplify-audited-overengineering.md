# Simplify audited over-engineering

**Status:** Awaiting approval

## Outcome

Apply every high-confidence cut from the repository-wide Ponytail audit while preserving extension behavior, persisted Minimal Subagents protocols, Pi lifecycle contracts, package loading, and the installed anti-slop policy. The expected result is roughly 1,400 fewer tracked lines and removal of the Turbo development dependency.

Read before implementation:

- [`../../AGENTS.md`](../../AGENTS.md)
- [`../agents/domain.md`](../agents/domain.md)
- [`../../CONTEXT-MAP.md`](../../CONTEXT-MAP.md)
- [`../adr/0002-publish-pi-extensions-as-source-typescript.md`](../adr/0002-publish-pi-extensions-as-source-typescript.md)
- every affected package `CONTEXT.md`
- all four Minimal Subagents ADRs in [`../../packages/pi-minimal-subagents/docs/adr/`](../../packages/pi-minimal-subagents/docs/adr/)
- [`../../.oxlintrc.json`](../../.oxlintrc.json)

This plan changes one user-visible source-data contract: `BibleVerseMessage` and `bibleVerseMessages` stop carrying undocumented `id`, `book`, and `verseCount` fields. Add a minor Changeset for `@ian-pascoe/pi-bible-verses`. The remaining work is behavior-preserving internal simplification and needs no Changeset or ADR.

## Boundaries

- Preserve all Bible passage text, references, translations, order, translation provenance, pool length, 20-passage Recent Passage Window, and Working Message output.
- Preserve ByteRover Recall, Curation, manual tools, timeout overrides, configuration, UI notifications, deduplication, and untrusted-memory boundary.
- Preserve Adaptive Thinking tool schemas, Session Baseline, Temporary Thinking Level, settings restoration, lock exclusion, retries, and notifications.
- Preserve Git Status Widget counts, symbols, two-second refresh, lifecycle refreshes, failure hiding, detached display, and non-TUI behavior.
- Preserve TPS Official → Tokenized → Estimated count precedence, model-keyed tokenizer caching, 250 ms throttling, timings, status text, and notifications.
- Preserve Minimal Subagents Registry V1/V2 parsing and event construction, Delivery Ledger transitions, Wait Event ordering, Delivery Evidence, branch replay, fork provenance/ownership, shutdown behavior, tool schemas, transcript compatibility, and rendered output.
- Preserve the two identical anti-slop trees as the intentional installer payload/deployed copy. Keep all anti-slop rules enabled at `"error"`.
- Retain `scripts/node-process-error.mjs`, the larger Adaptive Thinking/ByteRover/TPS/Git lifecycle host seams, the TPS tokenizer runtime seam, and the documented Minimal Subagents state machines.
- Treat `createRegistryEvent()` field-by-field construction as a persistence-boundary guardrail; do not collapse its switch arms into object spreads.
- Preserve current `.pi/settings.json` bytes and the existing two Minimal Subagents Changesets. Edit package versions only through Changesets.

## Coverage ledger

| Area                      | Confirmed cuts                                                                                                                                                                    | Step |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---: |
| Bible Verses              | Remove three unused record fields; use object-reference recency; inline the trivial lifecycle adapter                                                                             |    2 |
| ByteRover                 | Use the bridge's silent logger default; replace the session LRU with `Map`; use `findLastIndex`/`slice`; remove unread aliases/fields                                             |    3 |
| Adaptive Thinking         | Replace the synchronous retry/busy-wait lock path with proper-lockfile's asynchronous retries                                                                                     |    4 |
| Git/TPS                   | Use native timers in production and fake timers in tests; derive Git branch state from one porcelain-v2 call                                                                      |    5 |
| Minimal Subagents runtime | Merge identical runtime-open paths; remove unread runtime fields and duplicate validation; use `findLast`, `findLastIndex`, `Promise.withResolvers`, and direct `structuredClone` |    6 |
| Minimal Subagents edge    | Remove renderer dispatch boilerplate, one-call wait forwarding, unused schema registries, duplicate settings parsing, manual model deduplication, and unused `AgentId`            |    7 |
| Root infrastructure       | Remove redundant install/pack checks and an upstream-behavior test; simplify TypeBox parsing; replace Turbo with pnpm recursive scripts; remove stale helpers/ignores             |    8 |

Every ledger row is required. A deletion that cannot retain its stated behavior and focused checks must stop for review rather than widening the change.

## Implementation sequence

### 1. Establish the green baseline and protect the scope

Record:

```bash
git status --short
git rev-parse HEAD
pnpm verify
pnpm changeset:status
```

Record the current package test counts from the successful run. Confirm the only existing Changesets are the two Minimal Subagents entries already under `.changeset/`. Keep any working-tree changes that appear after this plan is approved outside the implementation diff.

Use the Coverage ledger as the implementation checklist. Do not add generalized helpers, configuration switches, compatibility layers, or replacement abstractions unless a later step explicitly names one.

**Complete when:** the starting commit, working-tree state, complete green verification, test counts, and existing Changesets are known before source edits.

### 2. Shrink the Offline Verse Pool and lifecycle

Update `packages/pi-bible-verses/src/bible-verses.ts`:

- Remove `id`, `book`, and `verseCount` from `BibleVerseMessage`.
- Remove those three properties from all 291 `bibleVerseMessages` records.
- Keep each record as a readable object containing only `text`, `reference`, and `translation`; do not convert the data to positional tuples or regenerate passage text.

Update `packages/pi-bible-verses/src/bible-verse-picker.ts`:

- Replace `recentMessageIds: string[]` with a queue of recently selected `BibleVerseMessage` object references.
- Filter availability with reference equality, append the chosen object, and retain the existing shift-after-20 behavior.
- Keep pool-size validation, injected randomness, and out-of-range random validation unchanged.

Update tests:

- In `test/bible-verse-picker.test.ts`, reduce fixtures to the three retained fields and assert deterministic selection/eviction through the unique `reference` values or object identities.
- Make the formatter case use the first real Offline Verse Pool entry and retain the exact Genesis Working Message assertion currently owned by the lifecycle test.
- In `test/bible-translations.test.ts`, replace ID uniqueness with reference uniqueness; retain pool length, non-empty text/reference, known-translation, exact provenance, and per-translation count assertions.
- Delete `test/extension.test.ts` and `src/bible-verse-lifecycle.ts`, including `registerBibleVerseLifecycle`, `BibleVerseLifecycleHost`, and `BibleVerseWorkingMessageHost`.
- Move the module-scoped picker and default extension into `src/index.ts`; register `turn_start` and `turn_end` directly on `ExtensionAPI`. Keep formatter/picker tests as the behavior check and the root entrypoint-loading test as the extension composition check.

Update the Recent Passage Window wording in `packages/pi-bible-verses/CONTEXT.md` and `README.md` from passage IDs to passage objects/passages. Add a minor Changeset that names the removed source-data fields and unchanged Working Message behavior.

Run:

```bash
pnpm --filter @ian-pascoe/pi-bible-verses typecheck
pnpm --filter @ian-pascoe/pi-bible-verses test
pnpm test:load
```

**Complete when:** exactly 291 ordered passages remain; references are unique; translation counts and provenance are unchanged; 20 selections cannot repeat by object identity; the 21st selection evicts the oldest; Working Message formatting still matches; the lifecycle adapter symbols and three removed fields are absent; one Bible Verses minor Changeset exists.

### 3. Remove ByteRover's local logger and cache machinery

Use `@byterover/brv-bridge`'s documented silent logger default:

- In `src/byterover-lifecycle.ts`, remove `LogLevel`, `logBrv`, every no-op logging call, the logger object built during session start, the logger-only `errorMessage` helper, and the `BrvLogger` dependency.
- Keep all user-facing `notifyBrv` calls and quiet-mode behavior.
- Change the injected production bridge-factory signature to accept only captured `BrvBridgeConfig` and the default working directory.
- In `src/byterover-bridge.ts`, remove the logger parameter from `createBrvBridgeConfig` and `createBrvBridgeFactory`, and omit `logger` when constructing `BrvBridge`.
- Update `test/index.test.ts` and bridge factory fixtures to use the shorter signature; assert the constructed bridge configuration omits `logger`, and remove console spies/assertions that only exercised or suppressed the deleted logger.

Replace the session-local LRU:

- Change `RuntimeState.curatedTurns` to `Map<string, string>` and construct a fresh `Map` at every successful `session_start`.
- Delete `src/lru-cache.ts`, `test/lru-cache.test.ts`, `maxCuratedTurnCacheSize`, and its import.
- Keep the existing `.get()`/`.set()` duplicate-curation checks.
- Add one local `ponytail:` comment at the `Map` declaration stating the ceiling: restore a bounded cache only if one active extension session can accumulate many distinct session keys.

Apply the remaining message-state cuts:

- Replace the `PendingRecall` wrapper and `Map<string, PendingRecall>` with `Map<string, Promise<string | undefined>>`; store and await the recall promise directly, eliminating the unread key and one-property wrapper.
- Remove the unused `SessionMessage` alias.
- Implement `selectMessagesInTurn()` with `findLastIndex()` plus `slice()`, returning the full list when it contains no user message.
- Retain the current message extraction, formatting, recall-window, and curation-key tests.

Run:

```bash
pnpm --filter pi-byterover typecheck
pnpm --filter pi-byterover test
```

**Complete when:** ByteRover constructs no logger, the removed cache module/test/constant are gone, each session starts with an empty standard `Map`, duplicate and in-flight Curation tests remain green, recall/persist override configurations remain exact, and every ByteRover test except the deleted cache implementation tests passes unchanged.

### 4. Use proper-lockfile's asynchronous retry path

Update `packages/pi-adaptive-thinking/src/adaptive-thinking-lifecycle.ts`:

- Delete `sleepSync()` and the manual `acquireSettingsLock()` loop.
- Keep creation of the agent/settings directory and dedicated lock target.
- Make `withSettingsLock()` await `lockfile.lock()` with `realpath: false` and a fixed retry policy equivalent to the existing bound: 99 retries after the first attempt, 20 ms minimum/maximum delay, and factor 1.
- Await the asynchronous release function in `finally`.
- Make `withSessionOnlyThinkingLevelChange()` asynchronous and await it from both tool execution and `resetTemporaryLevel()`.
- Keep settings reads/restores inside the acquired lock and keep `pi.setThinkingLevel()` itself synchronous.

Retain the existing tests proving persistent and temporary changes preserve unrelated settings and restore `defaultThinkingLevel`. Add one focused contention test that acquires the same lock target, schedules its release on a timer, starts a tool change, and proves the timer runs and the operation completes through asynchronous retry without blocking the event loop.

Run:

```bash
pnpm --filter pi-adaptive-thinking typecheck
pnpm --filter pi-adaptive-thinking test
```

**Complete when:** no busy-wait or `lockSync` remains; every settings mutation/reset awaits acquisition and release; contention retries within the existing bound; Session Baseline, Temporary Thinking Level, settings preservation, and failure messages remain covered and green.

### 5. Use native timers and one Git status process

#### Git Status Widget

Update `packages/pi-git-status-widget/src/git-status-widget-lifecycle.ts`:

- Retain `GitStatusWidgetLifecycleHost` and `GitStatusWidgetContext`.
- Delete `GitStatusWidgetRefreshLoop`, `GitStatusWidgetRefreshScheduler`, and `systemGitStatusWidgetRefreshScheduler`.
- Store `ReturnType<typeof setInterval>` directly; clear it before replacement and during shutdown.
- Remove the scheduler parameter from `registerGitStatusWidget()`.
- Remove `getFallbackBranch()` and the separate `git branch`, `git rev-parse`, and `rev-parse --is-inside-work-tree` calls.
- Run only `git status --porcelain=v2 --branch --untracked-files=normal` per refresh. Parse `# branch.head`, `# branch.oid`, and `# branch.ab`; display `detached@` plus the first seven OID characters when the head is `(detached)`.
- Derive the displayed branch after reading all headers so `branch.head` and `branch.oid` order is irrelevant; use `unknown` if a detached head lacks a usable OID.
- Let the status command's failure continue to hide the widget through the existing catch path.

Update `test/git-status-widget.test.ts`:

- Remove recording scheduler/loop types.
- Use Vitest fake timers and `vi.getTimerCount()` to prove session restart replaces the interval and shutdown removes it.
- Advance fake time by two seconds and prove the native interval performs another refresh.
- Reduce the fake Git executable and environment to the `status` command; make failure occur on that command.
- Include both `# branch.oid deadbee…` and `# branch.head (detached)` in the detached fixture.
- Retain the temporary real-repository test and all count/non-TUI/lifecycle assertions.

#### TPS Tracker

Update `packages/pi-tps-tracker/src/tps-tracker-core.ts`:

- Delete `TrackerClock` and `systemClock`.
- Remove the clock parameter from `registerTpsTracker()`.
- Read `Date.now()` at the existing timing points; retain all tokenizer loader/runtime interfaces.

Update `test/tps-tracker.test.ts`:

- Delete `RecordingClock`.
- Use `vi.useFakeTimers()`, `vi.setSystemTime()`, and `vi.advanceTimersByTime()` for elapsed-time and 250 ms throttle cases; restore real timers after each test.
- Keep exact status/notification text, count precedence, model cache, output-delta, multi-message reset, and unknown-encoding assertions.

Run:

```bash
pnpm --filter @ian-pascoe/pi-git-status-widget typecheck
pnpm --filter @ian-pascoe/pi-git-status-widget test
pnpm --filter @ian-pascoe/pi-tps-tracker typecheck
pnpm --filter @ian-pascoe/pi-tps-tracker test
```

**Complete when:** Git uses one subprocess per refresh and one native interval; detached/attached/count/failure output remains covered; TPS has no clock interface but every deterministic timing assertion remains exact under fake time; all focused checks pass.

### 6. Simplify Minimal Subagents runtime plumbing without touching protocols

Update `minimal-subagents-types.ts`, `minimal-subagents-sessions.ts`, `minimal-subagents-coordinator.ts`, and affected fixtures together:

- Remove unused `AgentId`; retain the used `TurnId` brand.
- Remove `sessionFile` and `sessionId` from `ChildAgentRuntime`, their `PiChildAgentRuntime` getters, and recording runtime fields. Keep `PersistedSessionIdentity.sessionFile/sessionId` as the persistence owner.
- Replace `RuntimeCreationRequest`, `AgentSessionFactory.createRuntime()`, and `restoreRuntime()` with one `openRuntime(agent)` operation.
- Remove the coordinator's `importedMessages` cache and its spawn-time write/delete logic. `createPersistentChildIdentity()` already appends imported messages before returning identity; `ensureRuntime()` must call the single runtime opener.
- Update recording factories in `test/coordinator.test.ts` and `test/extension.test.ts` to implement the one operation while retaining initialization, restoration, missing-dependency, and stale-runtime coverage.
- Keep launch and restoration dependency discovery separate; only the identical runtime-opening operation is merged.

Apply the state-neutral standard-library cuts:

- In `minimal-subagents-sessions.ts`, use `findLast()` in `findLatestChildSessionRecord()` and `findCurrentForkOwnership()`; leave `findLatestForkGeneration()` and its paired identity/provenance ordering logic unchanged.
- Keep entry discriminant and `Value.Check` predicates inside each `findLast()` callback so an invalid later record cannot hide an earlier valid one.
- In `minimal-subagents-registry.ts`, use `findLastIndex()` to select the latest checkpoint.
- Remove the source-turn ownership blocks immediately after `validateDeliveryIdentity()` and `validateCoordinationIdentity()`; retain the ownership checks inside those validators and all diagnostic tests.
- Replace the three manual deferred Promise constructors in the coordinator with `Promise.withResolvers<void>()`, preserving the exact resolve callbacks stored in waiter sets and pending messages.
- Delete `cloneTerminalDelivery()` and `cloneCoordinationDelivery()`; call `structuredClone()` directly at each existing immutable-copy boundary. Use an arrow in `map()` calls so the array index is not passed as `structuredClone`'s options argument. Retain delivery-ledger immutability tests.

Do not change `createRegistryEvent()`, registry wire schemas, registry event types, replay order, diagnostic strings, Delivery Ledger transitions, wait claims, queue ordering, or fork/session ownership.

Run:

```bash
pnpm --filter @ian-pascoe/pi-minimal-subagents typecheck
pnpm --filter @ian-pascoe/pi-minimal-subagents test -- coordinator.test.ts sessions.test.ts registry.test.ts delivery-ledger.test.ts extension.test.ts
```

If the package script does not forward file arguments through Vitest, run its configured Vitest command directly for those files, then run the complete package test command.

**Complete when:** one runtime-opening operation serves launch and restore; imported context is persisted exactly once; runtime-only session identity fields are gone; all three standard-library substitutions retain their focused tests; duplicate validation blocks are gone while every ownership diagnostic remains green; no persistence/state-machine code outside the named lines changes.

### 7. Remove Minimal Subagents edge-layer dispatch and parsing boilerplate

#### Rendering and render contracts

Update `minimal-subagents-rendering.ts`:

- Delete `CoordinatorToolCallRenderers`, `COORDINATOR_TOOL_CALL_RENDERERS`, `CoordinatorToolResultRenderers`, and `COORDINATOR_TOOL_RESULT_RENDERERS`.
- Keep the existing exhaustive `switch` statements and have each case call the corresponding render function directly. Inline the four short call renderings in their cases and continue using `renderManagementToolCall()` for cancel/delete.
- Preserve malformed fallback, collapsed/expanded/partial/error output, legacy details, colors, labels, and snapshots.

Update `minimal-subagents-render-contract.ts`:

- Delete the unused exported `coordinatorToolCallSchemas` table.
- Replace the exported six-entry result-schema table with only the two local union schemas actually required for current/legacy Agent Message details and message/turn Wait details.
- Keep every underlying TypeBox validator used at render ingress and keep all exported schema-derived types still imported by production code/tests.
- Remove the `TSchema` import when the deleted tables leave it unused.

#### Tools, settings, and capabilities

Update `minimal-subagents-tools.ts` and `test/tools.test.ts`:

- Delete `CoordinatorWaitToolParameters` and `executeCoordinatorWaitTool()`.
- Remove the `Static` import if it becomes unused.
- Call `coordinator.wait()` directly from the generated `subagent_wait` tool's execute handler with caller ID, agent ID, timeout, signal, and turn ID in the existing order.
- Replace the forwarding-helper test with a test that executes the generated wait tool using `ExtensionRunner.createContext()` and asserts argument/signal forwarding through the real definition.

Update `minimal-subagents-config.ts`:

- Delete `parsePiSettingsDocument()`.
- Keep `MinimalSubagentsSettingsDocumentInput` as the owner union; make `MinimalSubagentsConfigInput` and `readMinimalSubagentsSettings()` accept it, then pass Pi global/project settings directly from `resolveMinimalSubagentsSettings()`.
- Keep one `SettingsDocumentSchema` check in `readMinimalSubagentsSettings()` and retain warning text, scope, defaults, reset/null, role merge, and model-role validation tests.

Update `minimal-subagents-capabilities.ts`:

- Replace the manual `seen`/`result` loop in `buildEligibleModelIds()` with `new Set(source.map(({ provider, id }) => `${provider}/${id}`))` converted to an array.
- Retain source order, scoped-versus-available selection, canonical formatting, colon-bearing model IDs, and duplicate-removal tests.

Run:

```bash
pnpm --filter @ian-pascoe/pi-minimal-subagents typecheck
pnpm --filter @ian-pascoe/pi-minimal-subagents test
```

**Complete when:** every named dispatch/table/helper/parser/alias is absent; render snapshots and malformed/legacy fallbacks are unchanged; the real wait tool forwards all arguments; settings validate once; eligible model order and identities are unchanged; the complete Minimal Subagents suite passes.

### 8. Simplify root tests, install checks, pack checks, and workspace execution

#### Root contract tests

Update `scripts/root-project-contract.mjs` first:

- Implement `readJsonDocument()` with `Value.Parse(schema, JSON.parse(bytes))` and remove its `documentName` parameter.
- Give the JavaScript helper a generic JSDoc return contract from TypeBox `TSchema` to `StaticParse<TSchema>` so TypeScript callers retain schema-derived results without assertions.
- Remove `manifestDependencies` plus `dependencies` and `optionalDependencies` from `workspacePackageManifestSchema` after the Git-install traversal is deleted; retain `name` and `pi.extensions`.
- Update every root script/test call site to the two-argument helper.

Update `test/project-extension-overrides.test.ts`:

- Read manifests/settings through `readJsonDocument()` and the schemas in `scripts/root-project-contract.mjs`; remove the three local `JSON.parse` + `Value.Check` wrappers.
- Delete `NormalizedPackageSettingsEntry`, `MutablePackageSettingsConfiguration`, and `normalizePackageSettingsEntries()`.
- Narrow `piSettingsDocumentSchema` entries directly with `packageSettingsSourceSchema`; make `requireConfiguredExtensions()` accept the parsed object form or inline the check at its two call sites.
- Retain the tracked two-source coherence test and the offline workspace-versus-inherited-npm precedence test.
- Delete only `"can disable each workspace extension independently"`, which synthesizes settings to retest upstream `DefaultPackageManager` behavior rather than repository-owned configuration.

Update `test/extension-entrypoints.test.ts`:

- Import `readJsonDocument` and `rootPiManifestSchema` from `scripts/root-project-contract.mjs`.
- Delete the duplicate schema, static type, and parse wrapper.
- Keep exact ordered-path and successful-load assertions.

#### Git-install and pack scripts

Update `scripts/check-git-install.mjs`:

- Delete workspace directory discovery and declared dependency/optional-dependency traversal. A successful `npm install --omit=dev` plus loading all six source entrypoints remains the runtime dependency proof.
- Retain and rename the focused assertion that `byterover-cli` is absent from the production install.
- Remove imports and `workspacePackageManifestSchema` fields used only by the deleted traversal.
- Keep six-entrypoint count/order/error assertions and temporary cleanup.

Update `scripts/check-package-packs.mjs`:

- Delete the `npm pack --dry-run` call and its duplicate file-list validation; validate the real pack result once.
- Delete forbidden-prefix and nested-lockfile assertions already implied by the allowlist permitting only `LICENSE`, `README.md`, `package.json`, and `src/**`.
- Stop storing the unused workspace `directory` field.
- Inline `installedPackageDirectory()` at its only call site.
- Keep required files, allowlist, manifest fields, prohibited manifest fields, tar extraction, temporary installation, extension loading, and cleanup.

Remove `.pack-check` and `.git-install-check` from `.gitignore` and the Git-install copy exclusion because current scripts create only OS-temporary directories. Remove now-unused manifest dependency schemas from `root-project-contract.mjs`. Preserve `scripts/node-process-error.mjs`.

#### Replace Turbo with pnpm

Update root `package.json`:

```json
"test": "vitest run --config vitest.config.ts && pnpm -r --filter './packages/*' test",
"typecheck": "tsc --noEmit && pnpm -r --filter './packages/*' typecheck"
```

- Remove `turbo` from `devDependencies`.
- Delete `turbo.json`.
- Remove `.turbo` from repository ignores/copy exclusions after confirming no other owned script references it.
- Refresh `pnpm-lock.yaml` with `pnpm install --lockfile-only`.
- Confirm the path filter still selects exactly the six packages with `pnpm -r --filter './packages/*' list --depth -1`.

Run:

```bash
pnpm install --lockfile-only
pnpm typecheck
pnpm test
pnpm pack:check
pnpm git-install:check
```

**Complete when:** root and six package checks run without Turbo; `turbo.json` and the dependency are gone from the manifest/lockfile; the pnpm filter selects exactly six packages; root settings/entrypoint tests retain repository-owned proofs; real packs and production Git installation still load every intended extension; no removed temporary-directory name is produced anywhere.

### 9. Run the proof gate and audit the deletion

Run in order:

```bash
pnpm format
pnpm verify
pnpm changeset:status
git diff --check
git status --short
```

Then run focused absence checks:

```bash
test ! -e turbo.json
test ! -e packages/pi-bible-verses/src/bible-verse-lifecycle.ts
test ! -e packages/pi-byterover/src/lru-cache.ts
test ! -e packages/pi-byterover/test/lru-cache.test.ts
rg -n 'executeCoordinatorWaitTool|parsePiSettingsDocument|CoordinatorTool(Call|Result)Renderers|coordinatorToolCallSchemas|\bAgentId\b|\bTrackerClock\b' packages
rg -n 'lockSync|sleepSync|function acquireSettingsLock' packages/pi-adaptive-thinking/src
```

The searches must return no matches for removed symbols. Inspect the final diff rather than enforcing a line quota:

- every Coverage ledger item is present;
- deletions materially exceed additions;
- no replacement abstraction recreates a removed layer under another name;
- `.oxlintrc.json`, both anti-slop trees, `.pi/settings.json`, Minimal Subagents ADRs, Registry event construction, persisted schemas, and package versions are unchanged;
- the only new release metadata is one Bible Verses minor Changeset alongside the two existing Minimal Subagents Changesets;
- documentation changes are confined to the Bible Recent Passage Window wording, this plan, and that Changeset.

**Complete when:** `pnpm verify` and Changeset status pass, all focused removed-symbol searches are empty, package behavior and persistence invariants remain covered, and the final diff implements every ledger row without unrelated churn.

## Pause

Do not begin implementation until this plan is approved.
