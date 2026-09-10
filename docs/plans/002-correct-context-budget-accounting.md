# Plan 002: Count standing context once when deciding Rollover

> **Executor instructions:** Read this plan completely, follow its steps, and run each verification gate. Do not implement another plan incidentally. Update this plan's row in `docs/plans/README.md` when finished unless the coordinating reviewer owns the index.
>
> **Drift check:** From the repository root, run `git diff --stat 127e85a..HEAD -- packages/pi-context-management/src/context-window.ts packages/pi-context-management/src/context-management-extension.ts packages/pi-context-management/test/context-budget.test.ts packages/pi-context-management/test/context-management.test.ts packages/pi-context-management/README.md`. Compare any changed files with the excerpts below. An unexplained mismatch is a STOP condition; expected changes from another selected plan require explicit coordination, not overwriting.

## Status

- **Priority:** P1
- **Effort:** M — includes a bounded provenance feasibility gate
- **Risk:** MED — lowering an inflated estimate must not remove initial/post-checkpoint protection
- **Depends on:** None. Can run alongside Plan 001 if test-file ownership is coordinated; Plan 006 follows this plan.
- **Category:** bug / perf
- **Planned at:** commit `127e85a`, 2026-09-09
- **Status:** TODO

## Why this matters

Context Management currently adds an estimate for standing instructions and tools to Pi's usage-backed context total, although that total already includes the standing context. With large prompts/catalogues, this causes unnecessary warnings and premature Emergency Rollover. A native Context Checkpoint deliberately changes the conversation prefix, so premature checkpoints throw away reusable conversation-cache work unnecessarily. Fix the arithmetic; do not weaken Rollover, persistence, or overflow recovery.

An offline synthetic reproduction used 150,010 measured tokens, a 30,001-token standing estimate, and a 2,000-token safety margin in a 200,000-token window. The current result is 182,011 tokens (91.0%, causing Emergency Rollover), while the complete measured estimate plus margin is 152,010 tokens (76.0%). This is an accounting reproduction, not a measured provider-cache hit rate.

## Current state and constraints

### Package-owned code

`packages/pi-context-management/src/context-window.ts:156–194` contains shared accounting used both by the request safety guard and `/context` inspection. It exports `messageTokens`, `contextBudget`, and `boundedCheckpoint`.

```ts
function textTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 3);
}

const staticTokens =
  textTokens(session.agent.state.systemPrompt) +
  textTokens(
    JSON.stringify(
      session.agent.state.tools.map(({ name, description, parameters }) => ({
        name,
        description,
        parameters,
      })),
    ),
  );
const measured = session.getContextUsage()?.tokens;
const liveExtra = Math.max(0, messageTokens(messages) - messageTokens(session.messages));
const inputTokens =
  Math.max(messageTokens(messages), (measured ?? 0) + liveExtra) +
  staticTokens +
  settings.safetyMarginTokens;
```

`context-management-extension.ts:90–144` invokes `contextBudget(owner.session, configuration, messages)` **after** other context transforms. It warns at `warningThreshold` and commits an emergency native checkpoint at `emergencyThreshold`. The configuration defaults in `context-settings.ts:24–29` are 0.8, 0.9, and a 2,048-token margin. The reproduction above explicitly chose a 2,000-token margin; do not confuse it with the default.

`context-window.ts:203–244` uses `budget.staticTokens` separately to reserve standing instructions/tools when selecting the new Handoff, Note Index, and complete Tail. **Keep that return field and reservation logic.** Correcting the full-window total must not remove standing-context reservations for a fresh window.

### Installed Pi 0.85.1 semantics to preserve

Read these installed files before changing the formula; do not edit them:

- `node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js:86–87`: `calculateContextTokens` uses `usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite`.
- Same file, `:131–154`: `estimateContextTokens` uses the latest valid assistant usage plus estimated messages after that response. With no valid usage it estimates message content only. Aborted, errored, and all-zero assistant usage is ignored.
- `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:2708–2746`: `getContextUsage()` returns `tokens: null` after compaction until valid post-compaction usage exists; otherwise it returns that combined estimate.

Provider input includes standing instructions/tool schemas. Cache reads still occupy context, and generated output is part of subsequent conversation context. Do **not** subtract cache reads/output or add the model's maximum output setting to this formula. The reported `tokens` field is not necessarily a raw provider measurement: it may contain trailing-message estimates, or be entirely estimated before the first valid response.

### Vocabulary, intent, and conventions

Use package `CONTEXT.md` terminology: **Context Window**, **Context Checkpoint**, **Rollover**, **Emergency Rollover**, **Handoff**, **Note Index**, and **Tail**. ADR `docs/adr/0001-use-native-compaction-checkpoints.md` says: “Every Rollover should commit a native Pi compaction checkpoint” and requires preserved preflight/context transforms and fail-closed persistence handling. Native prefix replacement is intentional; duplicated accounting is not an ADR decision.

Match this source-TypeScript package's `.js` local import specifiers and existing Vitest assertions. Reuse `test/sdk-harness.ts`: `createSdkHarness()` supplies actual Pi collaborators with a scripted model stream; `reply(text, inputTokens)` supplies `inputTokens + 10` as total usage. Do not replace this with network calls or a new provider abstraction.

`test/context-management.test.ts:249–275` currently expects a warning after a 17,000-input-token response in a 24,000-token window. This test embeds the inflated behavior: with correct complete accounting, those numbers need not cross 80%. Adjust its scripted usage to intentionally cross the threshold rather than retaining the defective arithmetic to satisfy the test.

## Accounting decision and mandatory provenance gate

Only when the current standing context is proven identical to that associated with the specific valid usage estimate, compare **two complete estimates**, then add the safety margin once:

```ts
const projectedMessageTokens = messageTokens(messages);
const sessionMessageTokens = messageTokens(session.messages);
const liveExtra = Math.max(0, projectedMessageTokens - sessionMessageTokens);
const estimatedTotal = projectedMessageTokens + staticTokens;
const usageTotal = (measured ?? 0) + liveExtra;
const inputTokens = Math.max(estimatedTotal, usageTotal) + settings.safetyMarginTokens;
```

This is the unchanged-standing-context branch, not an unconditional replacement. `estimatedTotal` covers current standing context plus projected messages, including no-usage and post-compaction requests. `usageTotal` retains Pi's already-complete estimate plus additional live projection size. Do not add `staticTokens` to this verified unchanged branch.

Before implementing it, prove an in-memory association between the final outgoing standing context and the exact successful response usage subsequently selected by Pi. Include ordered tool names/descriptions/schemas, the finalized chained system prompt, and model identity. A fingerprint of the most recent budget invocation alone is not provenance: that invocation can be canceled, superseded, or precede another extension's prompt changes. On changed or unknown provenance, retain the old conservative accounting (`max(projectedMessageTokens, measured + liveExtra) + staticTokens + margin`). With no valid usage, use the complete current-content estimate plus margin. Invalidate associations on checkpoint, branch/model changes, reload, and unpaired/failed requests. Restored sessions may conservatively overcount until a new paired response establishes provenance.

Recompute standing instructions/tool estimates every call. Never memoize only by tool names: changing descriptions or schemas changes their size. Preserve `liveExtra` as non-negative; a shortened projection must not subtract an arbitrary character estimate from a provider-backed total.

**Safety requirement:** Aggregate usage cannot identify prior standing allocation. An unconditional maximum can hide arbitrarily large growth, not just a small delta: measured usage of 170,000 versus a current-content estimate of 80,000 still wins after adding 40,000 estimated static tokens. With a 2,000 margin it would report 172,000 despite potentially exceeding a 200,000 window. A margin and overflow retry are not a substitute for guarding this case. Require a regression that invalidates unchanged-static eligibility even while the current-content estimate remains below measured usage.

First prove the request/response association through existing lifecycle seams in a bounded offline SDK probe. If it requires a new private runtime seam or cannot identify finalized outgoing standing context, STOP with the trace and request a separate lifecycle design; do not ship the unconditional formula. Keep the implementation package-local and in-memory, without a provider tokenizer or persisted budget ledger. Document conservative fallback on changed/unknown provenance and the remaining approximate message/projection accounting.

## Scope

**Only implementation files allowed:**

- `packages/pi-context-management/src/context-window.ts`
- `packages/pi-context-management/src/context-management-extension.ts` — proven request/usage provenance lifecycle only; do not change warning delivery
- `packages/pi-context-management/test/context-budget.test.ts` (create)
- `packages/pi-context-management/test/context-management.test.ts`
- `packages/pi-context-management/README.md` — explain the two estimates and their limit, without claiming exact tokenization
- `docs/plans/README.md` — status row only, unless the reviewer owns it

**Read but do not modify:** `test/sdk-harness.ts`, `test/context-coexistence.test.ts`, `context-settings.ts`, `checkpoint-adapter.ts`, and the package ADR. Existing test helpers should suffice; stop if not.

**Out of scope:** Todo delivery, warning persistence (Plan 006), settings/default thresholds, model output reservation, tool exposure, native Pi code, JSONL editing, journal/adapter changes, new dependencies, provider cache controls, live paid-provider benchmarking, release/version files, and all other packages.

## Commands

Run from the repository root. Dependencies already exist. **Do not run an install during this task**: the audit's initial `pnpm exec` invoked preparation and refreshed ignored reference repositories. Direct installed binaries avoid that side effect. If dependencies are absent, stop and ask the operator to provision them.

| Purpose                       | Command                                                                                                                                                                                                                                                                                                                        | Expected result                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| Baseline / full package tests | `./node_modules/.bin/vitest run --config "$PWD/vitest.config.ts" --root packages/pi-context-management`                                                                                                                                                                                                                        | Exit 0; all package tests pass (audit baseline: 84 tests in 7 files) |
| Focused accounting tests      | `./node_modules/.bin/vitest run --config "$PWD/vitest.config.ts" --root packages/pi-context-management test/context-budget.test.ts test/context-management.test.ts`                                                                                                                                                            | Exit 0 after the fix                                                 |
| Package typecheck             | `./node_modules/.bin/tsc --noEmit -p packages/pi-context-management/tsconfig.json`                                                                                                                                                                                                                                             | Exit 0; no diagnostics                                               |
| Scoped lint                   | `./node_modules/.bin/oxlint packages/pi-context-management/src/context-window.ts packages/pi-context-management/src/context-management-extension.ts packages/pi-context-management/test/context-budget.test.ts packages/pi-context-management/test/context-management.test.ts`                                                 | Exit 0; no new violations                                            |
| Scoped format check           | `./node_modules/.bin/oxfmt --check packages/pi-context-management/src/context-window.ts packages/pi-context-management/src/context-management-extension.ts packages/pi-context-management/test/context-budget.test.ts packages/pi-context-management/test/context-management.test.ts packages/pi-context-management/README.md` | Exit 0                                                               |
| Whitespace check              | `git diff --check`                                                                                                                                                                                                                                                                                                             | Exit 0                                                               |

## Git workflow

Use the assigned implementation branch/worktree. Do not discard unrelated work. If asked to create a branch, use `fix/context-budget-accounting`; do not push or open a PR unless explicitly instructed. Match the repository's conventional message style, for example `fix(pi-context-management): avoid double-counting standing context`. No commit is required merely to execute this plan.

## Steps

### 1. Verify runtime semantics and reproduce the accounting defect

1. Run the drift check and full package baseline.
2. Read the installed Pi calculation paths listed above, the shared `contextBudget` callers, and the existing SDK harness. Record a blocking mismatch if the installed version no longer has the stated complete-usage/null-after-compaction semantics.
3. Create `test/context-budget.test.ts`. Prefer the real SDK harness to get usage from an actual scripted assistant response. The reduced-total assertion is conditional on the proven unchanged-standing provenance from Step 2; unknown-provenance fixtures must instead expect conservative fallback. Use a large standing prompt and a small actual message history so the provider-backed branch dominates. Configure a 200,000-token window and 2,000-token margin, return `reply("Ready", 150_000)`, and assert the next computed total equals Pi's complete usage estimate plus the margin, not that total plus standing context. Pi may add fixed prompt text, so compute expected static size from `budget.staticTokens` instead of assuming the harness yields exactly 30,001.
4. Assert the defective expression reaches 90% while the corrected result remains below 80%, and that `staticTokens` is still substantial and independently returned.

**Verify:** Run the focused accounting command. Before implementation, the new “counts standing context once” regression must fail on the total/threshold assertion, not on setup/import errors. Existing baseline tests must have passed first.

### 2. Correct only the complete-estimate comparison

Before the arithmetic change, add a test-only SDK probe that pairs finalized outgoing standing context with the successful usage selected by Pi. Cover two consecutive responses, trailing messages, cancellation/error, late prompt/tool changes, and branch/model/checkpoint invalidation. STOP if the association cannot be established through existing lifecycle seams. Then implement the guarded two-estimate branch and conservative changed/unknown-provenance fallback above. Compute the two message estimates once. Leave validation, `measuredTokens`, `staticTokens`, ratio denominator, return shape, explicit margin, and `boundedCheckpoint` reservations intact. Document the provenance requirement and conservative fallback beside the branch.

Update the existing 24,000-window warning fixture so its successful response plus margin deliberately lies between 80% and 90% under the corrected arithmetic (for example, approximately 18,000 input tokens, accounting for the harness's output and trailing input). Keep its purpose: maximum-output settings 512/12,000/24,000 do not change the full-window threshold, one warning is emitted, and no emergency checkpoint is created. Do not change transient-warning lifecycle assertions as part of this plan.

**Verify:** Run focused accounting tests and package typecheck; both must exit 0. The red regression must now pass without disabling the guard or changing settings defaults.

### 3. Protect fallback, live growth, and real checkpoint behavior

Add tests listed below. Add an end-to-end regression to `context-management.test.ts` using the real extension/harness: a 150,000-input-token response with a large standing prompt must allow the next ordinary request without creating a checkpoint or budget warning. Add a complementary legitimate measured crossing that still causes one Emergency Rollover before sending an oversized continuation.

For genuine standing growth, test both changed system text and an active tool with enlarged description/schema. Include the 170,000 measured / 80,000 current-content / 40,000 static-growth example: even though the current-content estimate remains below measured usage, provenance must invalidate and the conservative fallback must trigger protection. Also test identical metadata under fresh object allocation, reordered tools, unpaired restored usage, and abort/model/checkpoint invalidation. Never require the full-current-context estimate to win before noticing standing-context changes.

**Verify:** Run the full package command; all tests pass, including existing large-tool-result recovery, preserved History, no completed-tool replay, oversized-Handoff rejection, and compaction coexistence tests. Run scoped lint.

### 4. Document the accounting boundary and finish

Update the README budget paragraph: verified unchanged standing context permits comparing complete usage-backed/current-content estimates and adding the margin once; changed or unknown request/usage provenance retains conservative standing reservations. Message/projection accounting remains approximate. Do not claim a measured cache savings percentage.

Run all commands in the table. Review `git diff --name-only` against the scope, excluding unrelated pre-existing work. Update the index status or report completion to its owner.

**Verify:** Typecheck, full package tests, scoped lint, scoped format check, and `git diff --check` all exit 0. Only scoped files contain this plan's changes.

## Test plan

Use `test/sdk-harness.ts` and the current `context-management.test.ts` as structural examples. Add named cases covering:

1. Large unchanged standing context counted once when complete usage dominates; independent `staticTokens` reservation preserved.
2. No valid assistant usage: message estimate plus current static estimate plus margin, once each.
3. `getContextUsage().tokens === null` after a native checkpoint: ignore old pre-checkpoint usage and estimate the new Context Window; a new post-checkpoint response can reestablish usage-backed accounting.
4. All-zero/error/aborted assistant usage does not become a valid measurement. Let real Pi determine validity; do not duplicate its selection algorithm in production.
5. Nonzero output, `cacheRead`, and `cacheWrite`: use Pi's complete total once. Include native `totalTokens` and component-sum fallback in fixtures.
6. Trailing persisted messages are already included in Pi's estimate; no additional duplicate trailing count.
7. Larger live projection: add only the non-negative difference from session-message estimates to the usage-backed branch. A shrinking projection never subtracts from it.
8. Genuine system-prompt and ordered tool-description/schema changes invalidate unchanged-static eligibility, including growth hidden below a dominating measured total. Changed/unknown provenance uses the conservative fallback.
9. Real next request below threshold preserves the existing Context Window; real crossing creates exactly one checkpoint with History intact and no extra summarizer/network call.
10. Existing warning timing test uses meaningful corrected threshold inputs and remains independent of the model's maximum-output limit.

The arithmetic tests establish why a cache-destroying Rollover was unnecessary. They do not need a provider-payload serializer or paid API call: existing SDK tests prove that actual native checkpoints replace active context coherently.

## Done criteria

- [ ] New accounting regression fails against the original formula and passes with the fix.
- [ ] Full package tests, typecheck, lint, format check, and whitespace check exit 0.
- [ ] Below-threshold large-standing-context continuation creates no checkpoint or warning; legitimate crossing still protects the next request.
- [ ] Initial and post-checkpoint budgets retain standing-context estimation and the safety margin.
- [ ] `boundedCheckpoint` still reserves `staticTokens`; no changed persistence/recovery behavior.
- [ ] A real-SDK probe proves specific request/usage provenance; changed/unknown standing context cannot use the reduced unchanged-static branch.
- [ ] README and a concise code comment state provenance and conservative-fallback behavior honestly.
- [ ] No files outside scope changed by this implementation; index row updated by its assigned owner.

## STOP conditions

Stop and report instead of improvising if:

- Installed Pi usage semantics or the quoted source have changed materially.
- Correctness requires modifying the checkpoint adapter, shared SDK harness, Todo, or another plan's warning-delivery work.
- The implementation starts subtracting arbitrary message/static estimates from provider totals, drops cache/output occupancy, removes margin/static fallback, or changes settings to make tests pass.
- Specific successful response usage cannot be associated with finalized outgoing standing context through existing lifecycle seams. Do not infer it from aggregate tokens, a latest-budget-call fingerprint, or matching token counts.
- A regression fails twice after a focused correction, or test setup makes a real provider request.

## Maintenance notes

Future Pi changes to usage normalization, compaction staleness, or projected-context accounting require revisiting these tests. Dynamic tool catalogues and other extensions' context projections are inputs, not reasons to cache the standing estimate. Reviewers should check the placement of the safety margin outside the maximum and the preservation of `boundedCheckpoint.staticTokens` reservations. Plan 006 may later change warning persistence; coordinate its edits to the existing warning test without restoring this plan's old inflated thresholds.
