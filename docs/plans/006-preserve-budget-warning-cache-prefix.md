# Plan 006: Retain budget warnings at their first model-visible position

> Follow every verification gate. The first step is a bounded lifecycle probe, not permission to write session state from an arbitrary context hook. Stop if the safe boundary cannot be demonstrated. Update this plan's row in `docs/plans/README.md` when done unless the reviewer maintains the index.
>
> **Drift check:** `git diff --stat 127e85a..HEAD -- packages/pi-context-management`
> Read the changes from prerequisite plans 001 and 002 first; those are expected. Reconcile the excerpts below with the resulting implementation and stop on unexplained drift.

## Status

- Priority: P2
- Effort: M
- Risk: MED — extends an already guarded mutable Pi integration
- Depends on: plan 001 (Todo prefix stability and serializer tests), plan 002 (correct context accounting)
- Category: perf / bug
- Planned at: `127e85a`, 2026-09-09

## Known blocker: first-request persistence

**Implementation status: BLOCKED pending an explicit first-request policy.** The current adapter's durability guard (`checkpoint-adapter.ts:281–291`) rejects a session without a recorded assistant response, and Pi's SessionManager defers the initial journal flush until an assistant exists. Therefore the candidate below cannot provide immediate durable warnings for every currently valid initial request without changing that contract. This is a known conflict, not an unknown that repeated probing will resolve.

Before implementing, obtain approval for a narrowly specified initial-window exception or a separate persistence design. Document its exact warning timing and cache consequences, then revise this plan and its tests. Do not reject an otherwise valid initial prompt between warning and emergency thresholds, silently delay/remove its warning, or weaken the durability guard. The existing behavior remains until that decision is approved. The remaining steps describe the conditional post-decision candidate, not authorization to bypass this blocker.

## Why this matters

Context Management currently returns a warning as temporary tail context once per Context Window. Pi's Anthropic serializer writes the conversational cache endpoint on that final warning block. The next request omits the warning, so that particular written prefix cannot be reused. Unlike Todo's recurring issue, ordinary earlier checkpoints can still be reused and later turns can warm normally; this is a smaller, once-per-window cache loss.

Retain a warning at the same historical position after its first appearance, without triggering another model run or delaying the warning until after a potentially expensive response. Preserve the existing warning/emergency thresholds and fail-closed journal behavior. The implementation must prove its request/persistence ordering before changing production code.

## Current state and constraints

`packages/pi-context-management/src/context-management-extension.ts:90–109` computes a budget after public context projections, then does:

```ts
if (budget.ratio >= configuration.warningThreshold && warnedWindow !== window) {
  warnedWindow = window;
  const warning: AgentMessage = {
    role: "custom",
    customType: "pi-context-budget",
    display: false,
    timestamp: 0,
    content:
      "Context budget warning (~" +
      Math.round(budget.ratio * 100) +
      "% of full context window). Update Notes and prepare a Handoff; call context_rollover alone before the emergency threshold.",
  };
  ctx.ui.notify("Context budget warning: prepare a Handoff and Rollover.", "warning");
  return [...messages, warning];
}
```

`warnedWindow` resets on `session_start` and `session_tree`. The warning percentage is sampled once, not a live value that should rewrite past text.

Relevant files:

- `context-management-extension.ts` — policy, warning selection, native/emergency/explicit Rollover, failure handling.
- `checkpoint-adapter.ts` — the sole capability-gated mutable AgentSession seam. `transformWrapper` applies public projections first, then calls `afterTransformContext`, and reapplies projections after a checkpoint (`:317–344`). `commit` persists a checkpoint before replacing live messages and sets `refresh = true` (`:389–396`).
- `context-store.ts` — `assertContextJournalReadable` and `quarantineContextJournal`; preserve their existing fail-closed semantics.
- `test/checkpoint-adapter.test.ts` — real SDK, persistence, failed-write, and reopened-journal tests; use this as the integration pattern.
- `test/context-management.test.ts:249–275` — currently requires warning on request 3, no warning on request 4, and no warning in the journal. Change those assertions to **one new warning**, retained thereafter, not repeated new warnings.
- `test/sdk-harness.ts` — real session/resource/runtime collaborators with a scripted external model; traps accidental direct provider calls.
- `test/prompt-cache-prefix.test.ts` — introduced by plan 001; reuse its offline serialization check, do not duplicate a provider implementation.

Package vocabulary: **Context Window**, **Rollover**, **Context Checkpoint**, **Notes**, **History**, and **Handoff**. ADR `docs/adr/0001-use-native-compaction-checkpoints.md` requires one coherent live/persisted context definition and quarantines failed journals until reopened. Raw session-file edits and speculative rollback are expressly out of scope.

Important Pi behavior: `sendCustomMessage(..., { triggerTurn: false })` queues while streaming until `turn_end` (`node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:1098–1150`). Calling `pi.sendMessage` during the context transform therefore does **not** immediately persist the warning at the position being sent. Returning the warning now and queueing a later copy merely moves/duplicates it; that is not this fix.

## Candidate design, gated by Step 1

Use the existing checkpoint adapter, not a new shared framework or provider-specific breakpoint patch. Add one narrowly named operation for persisting a context-budget warning at the verified pre-request boundary:

1. The adapter has completed public projections, and the session contains the finalized user/assistant/tool-result messages for that request. Prove there is no unfinished assistant/tool-result group before attempting any append.
2. Persist a versioned hidden `pi-context-budget` **custom message** through the native SessionManager append method, carrying the current window identity and immutable warning text. Capability-check that append method along with existing capabilities; do not call a private AgentSession `_appendCustomMessage` method.
3. Only after acknowledged persistence, append the equivalent message to the live Agent state and set the existing `refresh` flag so the next loop snapshot cannot omit it. The current request returns its already-projected messages plus that _same_ warning once. Do not rerun arbitrary extension transforms solely to append the warning.
4. On append failure, quarantine/fault through the existing adapter/extension failure path and send no provider request. Do not claim rollback of SessionManager's potentially speculative in-memory entry.
5. Restore once-per-window warning identity from active selected-branch custom messages and their validated versioned details. Do not depend solely on the ephemeral `warnedWindow` variable. New checkpoints permit a new warning; historical warning text is never rewritten as the percentage changes.

This operation is allowed only inside the established adapter-controlled boundary, not in arbitrary tools/events. If the live-message update, refresh flag, persisted order, and current request cannot be made coherent without replaying user work or violating Pi ownership, STOP and report the lifecycle trace. Do not silently substitute a one-response delay, remove warnings, or bypass journaling safeguards.

## Scope

Only these files may change:

- `packages/pi-context-management/src/context-management-extension.ts`
- `packages/pi-context-management/src/checkpoint-adapter.ts`
- `packages/pi-context-management/test/checkpoint-adapter.test.ts`
- `packages/pi-context-management/test/context-management.test.ts`
- `packages/pi-context-management/test/context-lifecycle.test.ts`
- `packages/pi-context-management/test/context-coexistence.test.ts`
- `packages/pi-context-management/test/sdk-harness.ts` — minimal lifecycle/request-recording support only
- `packages/pi-context-management/test/prompt-cache-prefix.test.ts`
- `packages/pi-context-management/README.md`
- `packages/pi-context-management/docs/adr/0001-use-native-compaction-checkpoints.md` — explicitly record the proven narrow warning append boundary, not a general relaxation
- This plan's index status row

Out of scope: changing plan 002's accounting or thresholds, warning configuration knobs, removing fail-closed checks, background summaries, public tool schema changes, Todo production code, provider adapters, external packages, release files, manifests, lockfiles, and raw JSONL writes.

## Commands

Run at the repository root with existing dependencies. Avoid `pnpm exec` here: the audit observed its automatic install/preparation hook refreshing reference repositories.

| Purpose         | Command                                                                                                                                 | Success                      |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| Adapter probe   | `./node_modules/.bin/vitest run --config "$PWD/vitest.config.ts" --root packages/pi-context-management test/checkpoint-adapter.test.ts` | All probe/adapter tests pass |
| Context suite   | `./node_modules/.bin/vitest run --config "$PWD/vitest.config.ts" --root packages/pi-context-management`                                 | All pass                     |
| Todo regression | `./node_modules/.bin/vitest run --config "$PWD/vitest.config.ts" --root packages/pi-todo`                                               | All pass                     |
| Types           | `./node_modules/.bin/tsc --noEmit -p packages/pi-context-management/tsconfig.json`                                                      | Exit 0                       |
| Lint            | `./node_modules/.bin/oxlint packages/pi-context-management/src packages/pi-context-management/test`                                     | Exit 0                       |
| Format          | `./node_modules/.bin/oxfmt --check packages/pi-context-management`                                                                      | Exit 0                       |

Match existing NodeNext `.js` imports, TypeBox validation of persisted values/capabilities, and narrow Vitest SDK fixtures. Do not add a serialization or event-bus dependency.

## Steps

### 1. Resolve the first-request policy, then prove the remaining boundary

Do not begin production implementation until the known blocker above has an approved policy and this plan has been revised accordingly. Capture the existing first-request durability behavior once as evidence; do not spend repeated attempts trying to bypass it. Preserve acceptance of currently valid initial prompts.

Read the installed Pi extension documentation in full and follow its session-format/compaction references relevant to custom-message persistence. Extend the real-SDK adapter fixture with a test-only probe of the candidate native append operation; do not modify production yet. Record the active branch leaf, live messages, projected request, message-event sequence, and next-loop context before/after the probe.

The test-only probe must prove:

- A pre-request append follows the complete prior assistant/tool-result group, including multiple parallel results, CodeMode's outer result, user-only first requests, and queued steering input.
- The warning occurs exactly once in the outgoing request and exactly once in persisted/live history, at the same chronological position. A subsequent request extends that history rather than replacing the warning.
- A resumed session reconstructs the same model-visible warning content and role. Timestamp differences in internal representations are not used as a substitute for comparing serialized content.
- Setting the adapter's existing refresh mechanism carries the appended message into the next automatic tool-loop request without invoking an extra turn.
- Cancellation and journal failure prevent sending a request with unacknowledged warning history. Existing quarantine tests still pass.
- A checkpoint rebuild in the same preflight does not cause duplicate warning writes or recursive context transforms. Treat the verification projection (`canRollover === false`) explicitly; it must not re-enter the append operation accidentally.

Use an initial persistent fixture with a recorded assistant where required by the adapter's existing durability contract. Also explicitly test the first-request/no-recorded-assistant case. If that case cannot safely persist and represent the warning, report it; do not weaken the adapter's durability guard merely to pass.

**Verify:** Adapter probe command passes, with no provider network access. If it fails after two reasonable attempts, STOP with the smallest trace identifying the unsafe ordering. This is a bounded feasibility gate, not an open-ended refactor.

### 2. Add the failing cache-endpoint regression

After plan 002, configure/script usage so request A crosses the warning threshold but stays below the emergency threshold. Do not bake in the old double-counted budget. Confirm the warning is present on A and the following request is ordinary continuation, without compaction.

Use plan 001's Anthropic serializer capture: fake client, `onPayload` records payload and throws a checked sentinel before any transport. Assert A's complete conversational content through its marked `cache_control` endpoint remains a prefix of request B after stripping only marker annotations. Add an unchanged system/tools assertion. A second case with Todo enabled must preserve both the Todo snapshots and warning.

**Verify:** `./node_modules/.bin/vitest run --config "$PWD/vitest.config.ts" --root packages/pi-context-management test/prompt-cache-prefix.test.ts` fails specifically because A's warning endpoint disappears in B. Existing Todo-only cases from plan 001 remain green.

### 3. Implement the guarded warning operation and deduplication

Implement only the operation proven by Step 1 inside `CheckpointAdapter`. Add required callable capability checks and explicit boundary/reentrancy guards. Reuse `ready()`, readable-journal checks, adapter faulting, and `refresh`; do not introduce another mutable session owner. Persist first, update live state second, return one immutable model-visible message to the existing already-projected request. A synchronous native append acknowledgment is not a claim of transactional rollback.

Update warning selection in `context-management-extension.ts` to call the operation rather than append a transient message. Set in-memory warning identity and notify the user only after the append is acknowledged. Store versioned details identifying the current window; derive the current identity from the selected native compaction entry or initial window. On resume/tree/reload, consult selected active history to avoid duplicates, ignoring malformed records with the package's existing validation discipline.

Do not move changing percentages into system instructions. A previously emitted warning remains the percentage observed at that moment. A new actual Context Window can emit its own warning without editing the old one.

**Verify:** Adapter probe, full Context suite, Todo suite, and typecheck all pass. The Step 2 warning-prefix regression is now green.

### 4. Finish persistence, coexistence, and documentation checks

Update the existing request-3/request-4 test: request 3 introduces one warning; request 4 retains the identical historical warning but introduces no second one. The journal now contains one corresponding custom message. Assert counts and identity, not only substring presence.

Add cases for first request, ordinary tool loop, parallel tools, CodeMode, Todo, retry after abort, resuming, resource reload, selected-branch tree navigation, native/manual/emergency checkpoint paths, and a new window warning. Inject a journal append failure and assert no subsequent provider call, quarantine, no falsely successful UI notice, and recovery only after reopening the persisted session. Include a warning attempt during post-checkpoint verification and verify no recursive append/rebuild.

Document that warnings are immutable hidden contextual messages, once per active window, and survive normal replay until compaction. Update ADR-0001 only to describe the verified adapter-owned warning append seam and its fail-closed constraints; do not relax the checkpoint rules.

**Verify:** All six command-table checks pass; `git diff --name-only` contains only scope (plus already committed prerequisite work). No production code outside the adapter/extension was needed.

## Done criteria

- [ ] An explicit approved first-request policy resolves the documented durability conflict without rejecting previously valid prompts; this plan and index are updated before implementation.
- [ ] A real-SDK lifecycle probe proves safe persistence for every case covered by that policy before production code changes.
- [ ] Warning delivery is not delayed a model response and does not trigger a new response.
- [ ] Previously written warning cache endpoints survive ordinary following requests.
- [ ] One warning is persisted per active window; reload/resume do not duplicate it.
- [ ] Historical warning text is immutable; new windows and branch selection behave correctly.
- [ ] Partial tool groups, nested calls, cancellation, checkpoint reprojection, and failed writes are covered.
- [ ] Existing Context Management quarantine/failure tests and Todo prefix tests pass.
- [ ] Types, lint, formatting, scope, README/ADR, and index status are complete.

## STOP conditions and maintenance

Remain BLOCKED until the first-request policy is approved. Stop if Step 1 cannot prove a safe finalized pre-request append, if the only available path silently delays the warning or starts another model run, if another hook can be replayed unsafely, if live/persisted/request order diverges, or if the first-request case requires weakening durability. Stop on unresolved prerequisite drift, a twice-failing verification gate, or a required out-of-scope production change.

Reviewers must inspect persistence ordering rather than accept a string-equality-only test. This is a lower-frequency optimization than Todo; if the narrow seam proves unsafe, mark the plan BLOCKED with the evidence instead of enlarging the adapter into a general message framework. Future Pi event/loop changes require rerunning the capability, finalized-tool-group, and reopened-session tests.

Use conventional commit style if instructed to commit, for example `fix(pi-context-management): retain warning cache endpoints`. Do not push or create a PR without instruction.
