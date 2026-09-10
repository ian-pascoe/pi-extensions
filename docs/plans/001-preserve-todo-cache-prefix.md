# Plan 001: Preserve Todo conversation cache prefixes

> Follow the steps and verification gates in order. Do not implement outside the scope below. On completion, update this plan's row in `docs/plans/README.md` unless the coordinating reviewer owns that file.
>
> **Drift check:** `git diff --stat 127e85a..HEAD -- packages/pi-todo packages/pi-context-management/test/context-coexistence.test.ts packages/pi-context-management/test/sdk-harness.ts`
> Compare any changed files against the excerpts before proceeding. Reconcile intentional prerequisite changes; stop on unexplained behavioral drift.

## Status

- Priority: P1
- Effort: M
- Risk: MED — request ordering, restoration, and compaction
- Depends on: none
- Category: perf / bug
- Planned at: `127e85a`, 2026-09-09

## Why this matters

Todo currently appends a temporary snapshot before every model request. Pi 0.85.1's Anthropic serializer marks the final user block as its conversation cache write endpoint. The next request removes that snapshot from its previous position and moves it to the new tail. Even when Tasks do not change, the previously written conversational prefix is missing. A stable byte prefix is insufficient if no cache entry was written at that endpoint.

The fix must preserve old model-visible snapshots, publish new state only when necessary, and still make the correct Todo List available immediately after Rollover. It must not trade away branching or CodeMode correctness for caching. This plan does not claim measured provider cache-hit improvements; its gate is an offline serialized-prefix regression.

## Current state and contracts

- `packages/pi-todo/src/pi-todo-extension.ts:115–125` stores state through `pi.appendEntry("pi-todo-state", state)` inside `commitTodoState`. `runTodoAction` is shared by the direct tool, nested execution through CodeMode's wrapped registry, and `/todo clear`.
- `pi-todo-extension.ts:132–142` currently contains:

  ```ts
  pi.on("context", (event) => {
    if (state.tasks.length === 0) return;
    const todoListMessage = {
      role: "custom",
      customType: "pi-todo-context",
      content: `Todo List:\n${formatTodoList(state.tasks)}`,
      display: false,
      timestamp: 0,
    } as const;
    return { messages: [...event.messages, todoListMessage] };
  });
  ```

- `todo-list.ts` owns `TodoStateSnapshot`, `TodoStateRecord`, validation, numeric ordering, and `formatTodoList`. Reuse them. `applyTodoAction` is pure; do not move Pi effects into it.
- `CONTEXT.md` defines **Task**, **Task Status**, and **Todo List**. Preserve unconstrained status changes, duplicate titles, flat Tasks, and current numeric ID semantics.
- `README.md` currently claims hidden tail context preserves the cacheable prefix. Replace that inaccurate paragraph when implementing.
- `test/pi-todo-extension.test.ts:306` tests a purported cache-friendly projection, but not two growing serialized requests. Its harness records only the current small ExtensionAPI surface.
- `packages/pi-context-management/test/context-coexistence.test.ts:9–35` proves real Todo state survives native Rollover and currently requires _no_ persisted `pi-todo-context` custom message. That assertion must change, not be retained as an architectural requirement.
- Pi custom **entries** are model-invisible; custom **messages** are persisted and become user messages during `convertToLlm`.
- Installed Pi `dist/core/agent-session.js:1098–1150` implements `sendCustomMessage`: explicit `{ triggerTurn: false }` while streaming defers a custom message until `turn_end`, after the entire assistant/tool-result group. It appends immediately without starting a turn when idle. Do not use implicit steering or `triggerTurn: true` for Todo updates.
- Context Management can commit a checkpoint inside its context transform (`src/checkpoint-adapter.ts:317–344,389–396`). That path replaces active messages without emitting the ordinary `session_compact` lifecycle event. A `session_compact` listener alone is therefore not a complete Todo restoration solution.

## Chosen implementation shape

1. Keep `pi-todo-state` entries as the authoritative, backward-compatible state journal.
2. After a successfully committed _model-visible_ state change, publish a full, immutable, hidden `pi-todo-context` custom message with `pi.sendMessage(..., { triggerTurn: false })`. Use `formatTodoList`; include the explicit empty state after clear/removing the final Task. Retain old messages unchanged. Deduplicate identical formatted state, not only object identity: an update that writes the same values need not publish another snapshot.
3. Bootstrap a legacy/restored branch once at a safe `before_agent_start` message boundary if the active context lacks the applicable full snapshot. Return the message from that hook rather than triggering a second run. Do not publish an empty snapshot on a brand-new empty session. A previous nonempty snapshot followed by a persisted clear must, however, be superseded by an explicit empty snapshot.
4. Preserve a **pure, fixed-position checkpoint baseline** projection for compaction, instead of the old moving live-state suffix. Derive the baseline from the persisted Todo state immediately **before the selected checkpoint's `firstKeptEntryId`**, and insert it immediately after that checkpoint's `compactionSummary`, before its retained Tail. Later retained/new durable Todo snapshots supersede it chronologically. The baseline must depend only on the immutable checkpoint cutoff and earlier journal records, never on mutable current state. Reapplying it on later requests produces identical content at the same position; another actual checkpoint is the only reason to replace it.
5. If checkpoint/cutoff-to-message mapping cannot be demonstrated against the real SDK, stop after the probe below. Do not invent synthetic IDs, rebuild another extension's messages, write raw session files, or mutate AgentSession internals from Todo.

The checkpoint baseline is derived from existing durable journal data, not a new mutable summary. This is intentionally narrower than a general context-projection framework.

## Scope

Only these paths may change:

- `packages/pi-todo/src/pi-todo-extension.ts`
- `packages/pi-todo/src/todo-context.ts` — optional new package-local projection helper if keeping the logic in the extension obscures it
- `packages/pi-todo/test/pi-todo-extension.test.ts`
- `packages/pi-todo/test/todo-context.test.ts` — optional pure projection tests
- `packages/pi-todo/README.md`
- `packages/pi-context-management/test/context-coexistence.test.ts`
- `packages/pi-context-management/test/sdk-harness.ts` — only test support for recording full contracts/request projections
- `packages/pi-context-management/test/prompt-cache-prefix.test.ts` — new offline integration/serializer regressions
- This plan's status row in `docs/plans/README.md`

Out of scope: Todo schema/actions/ID semantics, widget rendering, Context Management production adapter, provider production adapters, CodeMode production code, other extensions, dependency additions, release files/version bumps, external state files, and cache-retention configuration.

## Commands

Run from the repository root. Dependencies already exist. The audit observed `pnpm exec` automatically running installation/preparation and refreshing reference repositories, so use the installed binaries for these checks; do not reinstall as part of this plan.

| Purpose             | Command                                                                                                     | Success  |
| ------------------- | ----------------------------------------------------------------------------------------------------------- | -------- |
| Todo tests          | `./node_modules/.bin/vitest run --config "$PWD/vitest.config.ts" --root packages/pi-todo`                   | All pass |
| Context integration | `./node_modules/.bin/vitest run --config "$PWD/vitest.config.ts" --root packages/pi-context-management`     | All pass |
| Todo types          | `./node_modules/.bin/tsc --noEmit -p packages/pi-todo/tsconfig.json`                                        | Exit 0   |
| Context types       | `./node_modules/.bin/tsc --noEmit -p packages/pi-context-management/tsconfig.json`                          | Exit 0   |
| Lint                | `./node_modules/.bin/oxlint packages/pi-todo/src packages/pi-todo/test packages/pi-context-management/test` | Exit 0   |
| Format              | `./node_modules/.bin/oxfmt --check packages/pi-todo packages/pi-context-management/test`                    | Exit 0   |

Source-TypeScript conventions: explicit `.js` imports under NodeNext, TypeBox boundary validation, Vitest behavior tests, and narrow test fakes. Match the existing Todo harness and Context Management's real-SDK harness rather than introducing a framework.

## Steps

### 1. Prove the safe publication and checkpoint-baseline seams

Add characterization cases to `context-coexistence.test.ts` using its real Todo loading path and `createSdkHarness`. Record custom-message events, persisted branch entries, and consecutive requests.

Prove all of the following before changing production behavior:

- `sendMessage` with explicit `triggerTurn: false` during a direct tool execution is appended after every sibling tool result, is present before the next request, and does not create an extra request after a text-only final response.
- The same holds when Todo is called within a CodeMode Cell, including a Cell that mutates Todo and subsequently throws.
- The selected native compaction's `firstKeptEntryId` is findable in the selected branch, and its preceding valid `pi-todo-state` can be recovered. The corresponding incoming `compactionSummary` can be identified without reconstructing the entire request.
- Empty Tail, nonempty Tail, a cutoff before a Todo mutation, and a cutoff after it produce the correct chronological baseline plus retained updates. Check both native `session.compact()` and Context Management's in-loop Rollover.

Read the installed Pi `docs/extensions.md` completely and the referenced session-format/compaction docs relevant to these seams. Inspect the installed implementation, not an unverified newer reference checkout.

**Verify:** Run Context integration tests above. Characterization cases pass; no external provider is called. If any seam fails, STOP and report the observed request/journal order before selecting a different design.

### 2. Add regressions that fail under the moving-suffix implementation

Create `prompt-cache-prefix.test.ts` using the real SDK harness and offline provider serialization. Obtain the Anthropic API implementation from the installed `@earendil-works/pi-ai` package (resolve its entrypoint then the internal `dist/api/anthropic-messages.js` file if the subpath is not exported). Supply a fake client and intercept `onPayload`, save the payload, then throw a sentinel error **before** transport. Assert the sentinel path; never let a real client/network call run. Convert custom messages through Pi's real `convertToLlm`.

For two growing requests, locate the prior serialized conversational block bearing `cache_control`. Remove only cache-control annotations when comparing content/roles; assert the complete content sequence through that prior endpoint remains the next request's prefix. Keep system/tools identical. This is a structural assertion, not a simulated cache-hit percentage. Include a control case that appends ordinary history without Todo and passes.

**Verify:** Run the new file with `./node_modules/.bin/vitest run --config "$PWD/vitest.config.ts" --root packages/pi-context-management test/prompt-cache-prefix.test.ts`. The ordinary-history control passes; the unchanged-Todo growing-prefix case fails for the missing former snapshot, not an import/transport error.

### 3. Publish durable snapshots and implement fixed checkpoint baselines

Implement the chosen shape in the Todo extension, reusing `runTodoAction` so direct calls, CodeMode calls, and manual clear share one publication path. Commit the existing state entry successfully before publishing the model-visible snapshot. Never acknowledge publication as durable before Pi records it; retries/restoration must consult branch data rather than trust an in-memory last-sent flag alone.

Restore branch state as before; detect already applicable active snapshots using their custom type and validated versioned details. Preserve historical snapshots byte-for-byte. On initialization of legacy state, publish one current snapshot at the next safe prompt boundary; on repeated reload/resume without a state/context change, publish none. Do not put state in system prompts or tool descriptions.

Implement the pure checkpoint baseline only after Step 1 proves the mapping. It must be idempotent if a transform is reapplied, use the pre-cutoff state (not current state), preserve every foreign message and tool-call/result group, and be stable when current Tasks subsequently change. A baseline inserted before the retained Tail must not overwrite newer retained state logically. If no Todo state existed before the cutoff, omit the baseline rather than inventing one.

**Verify:** Todo tests, Context integration tests, and both typecheck commands pass. The Step 2 cache-prefix test now passes.

### 4. Finish lifecycle and failure coverage, then correct the documentation

Required cases:

- Add → unrelated tool → unchanged next user turn retains the previous cache endpoint.
- Update publishes one new full snapshot; prior snapshots remain unchanged. `list`, same-value update, and repeated empty clear do not append redundant model messages.
- Remove-final-Task and `/todo clear` publish explicit empty state without triggering a model run; canceled confirmation publishes nothing.
- Restart/reload/fork/tree restore the selected branch, never a sibling's Tasks, without duplicating already-active snapshots.
- A legacy journal containing only custom state entries gets one bootstrap; invalid state records are ignored using the existing validator.
- Ordinary and emergency Rollover preserve the latest Tasks immediately in the first fresh request, including a retained Tail with older and newer Todo snapshots. Subsequent unchanged requests retain the first fresh window's endpoint.
- Multiple direct Todo calls, nested CodeMode calls, cancellation, and a later Cell failure never split assistant tool calls from their results or lose an acknowledged mutation.
- Failed state-entry writes do not emit a successful new snapshot. Publication/persistence errors do not silently mark missing snapshots as delivered; unsupported recovery behavior is a STOP condition, not a reason to swallow errors.

Replace the README's moving-tail claim with the durable-update/fixed-baseline behavior. Update the existing tests that prohibit all persisted `pi-todo-context` messages. Keep widget/rendering expectations unchanged.

**Verify:** All six check commands above exit 0. `git diff --name-only` contains only the allowed scope.

## Done criteria

- [ ] Both package test suites and typechecks pass; scoped lint/format pass.
- [ ] Offline cache-endpoint regressions cover unchanged turns, actual mutations, clear, and post-Rollover.
- [ ] Full state is delivered for direct and nested tool mutations without extra model runs.
- [ ] No live-state snapshot is appended by every `context` invocation.
- [ ] Any remaining context projection is a pure, fixed-position function of an immutable checkpoint cutoff and prior journal state.
- [ ] Selected-branch restoration, legacy journals, retained Tail ordering, and failed writes are covered.
- [ ] README no longer describes the old moving suffix as cache-preserving.
- [ ] Scope verified and index status updated.

## STOP conditions and maintenance

Stop if the public non-triggering message path does not preserve the next-request ordering, the checkpoint baseline cannot be matched unambiguously, another context transform destroys its anchor, the first post-Rollover request loses current Tasks, or production changes outside scope appear necessary. Stop if any verification fails twice after reasonable correction. Do not compensate with provider-specific payload rewriting or private Todo-owned session mutations.

Pi Todo currently advertises Pi >=0.84.1 while the audited runtime is 0.85.1. Verify the public APIs/semantics used against that supported floor before release; report a compatibility decision instead of silently bumping it. Future tool-execution scheduling or native compaction changes must rerun the real-SDK ordering tests. Reviewers should reject fixes that merely compare two empty-history projections or stop showing Todo state to avoid caching costs.

Use a focused branch only if requested; follow existing conventional commit style (for example `fix(pi-todo): preserve conversation cache prefixes`). Do not push or open a PR without instruction.
