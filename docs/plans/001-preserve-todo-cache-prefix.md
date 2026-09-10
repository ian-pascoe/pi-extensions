# Plan 001: Preserve Todo conversation cache prefixes

> Revised implementation approved after the original non-triggering message probe failed. The coordinating reviewer owns the status row in `docs/plans/README.md`, independent review, and final commit.

## Status and scope

- **DONE — 120 tests, both package typechecks, scoped lint/format, and independent standards/spec review pass. Recovery was explicitly deferred by the user; no upstream changes.**
- Priority: P1; effort: M; risk: MED (ordering, restoration, compaction)
- Depends on: none; category: perf / bug
- Planned at `127e85a`, 2026-09-09; diagnostic baseline `17d0643`
- Implementation verification targets installed Pi 0.85.1. No provider cache-hit improvement is claimed.

Allowed paths:

- `packages/pi-todo/src/pi-todo-extension.ts`
- `packages/pi-todo/src/todo-context.ts`
- `packages/pi-todo/test/pi-todo-extension.test.ts`
- `packages/pi-todo/test/todo-context.test.ts`
- `packages/pi-todo/README.md`
- `packages/pi-context-management/test/context-coexistence.test.ts`
- `packages/pi-context-management/test/sdk-harness.ts` (test support only)
- `packages/pi-context-management/test/prompt-cache-prefix.test.ts`
- This plan and its coordinating-reviewer-owned index row

No Todo schema/action/ID changes, widget redesign, Context Management production edits, provider or CodeMode production edits, dependencies, release/version files, external state files, or private Pi journal/agent mutation.

## Problem and rejected design

The original Todo transform appends mutable current state at the end of every request. Pi's Anthropic serializer marks the final user block as a conversation cache write endpoint. On the next request the former snapshot is removed from that endpoint and placed at the new tail, breaking the written prefix even when Tasks do not change.

The initial plan proposed `pi.sendMessage(..., { triggerTurn: false })` after a successful state mutation. The real-SDK probe in diagnostic commit `17d0643` proved that Pi records that message after all sibling tool results, but its running agent loop has a separate message array: the next automatic request omits the message, while a later user prompt includes it. That path cannot meet immediate delivery. The approved revision uses the existing state journal directly, not a second persistence channel or bootstrap message.

## Approved design

1. **One authoritative journal.** Keep backward-compatible immutable `pi-todo-state` records. Reuse `TodoStateRecord`, `parseTodoStateSnapshot`, and `formatTodoList`. The shared `runTodoAction` covers direct tools, CodeMode nested calls, and manual clear. Append successfully before advancing local state or the widget. No `sendMessage`, extra model turn, or mutable last-sent flag.
2. **Stable full snapshots.** Purely project changed formatted state at its immutable journal position. Retain previous snapshots byte-for-byte. Deduplicate only consecutive identical formatted states, including same-value updates and repeated clears. Clear/removing the final Task supersedes prior nonempty state explicitly. A brand-new empty session has no snapshot.
3. **Complete tool groups.** A mutation between an assistant's tool calls and its results waits until all that group's results. Multiple mutations remain chronological, including multiple direct calls and a CodeMode Cell that mutates then fails. Match the complete anchor message, not a globally unique tool-call ID assumption.
4. **Fixed checkpoint baseline.** Read the selected branch's latest compaction and locate its `firstKeptEntryId`. Project the latest valid state strictly before the cutoff immediately after the matching `compactionSummary`. Retained states and later changes supersede it at their respective boundaries. Never derive the baseline from mutable current state. Reapplication is idempotent.
5. **Preserve foreign context.** Derive anchor messages using the older public standalone `buildSessionContext` export. Do not rebuild or reorder incoming foreign projections. Remove/recreate only Todo projections carrying validated version-1 details (`stateEntryId`, nullable `checkpointId`). A missing/ambiguous anchor or incomplete mutation tool group is an explicit error, not guessed placement.
6. **Restoration.** Legacy journals require no migration/bootstrap record: they yield the same fixed historical projections. Restore only the selected branch on session start/reload/resume/fork and tree navigation. Invalid records are ignored with the existing structural and semantic validators.
7. **Failure quarantine.** Pi appends to its live branch before its synchronous file write can fail. Keep a Todo-owned `Symbol.for` metadata marker on the public manager keyed to its native header identity, following the repository's existing Context Store quarantine pattern. This explicitly approved metadata is not mutation of Pi-owned journal/agent fields. A failed append never advances acknowledged Todo state; all further Todo restoration/actions/context fail in that loaded session. `/reload` alone must remain quarantined. Recovery and repair of Pi's pre-existing failed-write history links are explicitly deferred, not completion gates for this cache-prefix change. Reopening is not promised to repair history. Context exceptions are swallowed by Pi, so also call public `ctx.abort()` without awaiting it. Verify the real transport observes cancellation; do not mistake a thrown transform for a stopped request.

## Verification sequence and seams

The approved seams are the Todo ExtensionAPI boundary, pure package-local projection, real Pi SDK request/lifecycle behavior, and the installed offline Anthropic serializer.

### 1. Characterize before implementation

Read installed Pi extension/session/compaction docs and implementation. Retain the original failed-delivery characterization as a diagnostic, not a success claim. Prove journal-derived projection after a complete sibling group remains fixed on the next user request. Prove native `session.compact()` and in-loop Context Management Rollover expose matching summary/cutoff anchors with empty and nonempty Tail. These probes passed before production edits.

### 2. Red serializer regression

Capture real SDK requests after Pi's real `convertToLlm`. Load the installed Anthropic serializer, supply a fake client, record `onPayload`, and throw an asserted sentinel before transport. Keep an ordinary-history control. Locate the previous conversational block bearing `cache_control`; compare the entire content/role prefix through that endpoint with the next request, removing only cache-control annotations. Assert stable system prompt and full tool definitions. The control passed while the old moving Todo suffix failed for its missing prior snapshot.

### 3. Implement and cover lifecycle/error behavior

Required behavior gates:

- Growing requests preserve written endpoints for unchanged state and actual later updates.
- Full snapshots appear immediately after direct/multiple/sibling and nested CodeMode mutations, without splitting tool groups or introducing requests.
- Same-value updates/list/repeated empty clear add no redundant model snapshots. Remove-final-Task and manual clear expose empty state; canceled confirmation or canceled execution changes nothing.
- Legacy valid state, invalid records, reload/resume, fork, and tree navigation preserve only selected-branch Tasks and fixed snapshot positions.
- Native compaction and ordinary/emergency Rollover expose correct state in the first fresh request, including empty and nonempty Tail; later mutations cannot rewrite its baseline or previous endpoint.
- Foreign message objects/order remain untouched; repeated application is identical. Destroyed or ambiguous anchors fail explicitly.
- Failed append does not acknowledge new state; speculative native in-memory records cannot become authoritative after `/reload`. Actual provider transport must respect context-abort failure handling. Characterize the existing host history-link failure independently of Todo; automatic recovery is outside the user-approved scope.

### 4. Checks, documentation, review

Run from repository root, using installed binaries (avoid `pnpm exec`, which triggered reference-repository preparation during the audit):

```bash
./node_modules/.bin/vitest run --config "$PWD/vitest.config.ts" --root packages/pi-todo
./node_modules/.bin/vitest run --config "$PWD/vitest.config.ts" --root packages/pi-context-management
./node_modules/.bin/tsc --noEmit -p packages/pi-todo/tsconfig.json
./node_modules/.bin/tsc --noEmit -p packages/pi-context-management/tsconfig.json
./node_modules/.bin/oxlint packages/pi-todo/src packages/pi-todo/test packages/pi-context-management/test
./node_modules/.bin/oxfmt --check packages/pi-todo packages/pi-context-management/test docs/plans/001-preserve-todo-cache-prefix.md
```

Update README to describe immutable journal projections and fixed checkpoint baselines, not a cache-friendly moving suffix. Parent runs independent standards/spec review, verifies scope, updates the index only on success, and commits. Do not push or open a PR.

## Known host persistence limitation — recovery deferred

Independent review and a separate coordinator run reproduced this on installed Pi 0.85.1 using the real SDK, production Todo, a scripted offline provider, and an actual EACCES append failure:

1. Successfully persist and acknowledge Task A.
2. The next Todo append updates Pi's live branch/leaf before its synchronous disk append fails.
3. `ctx.abort()` stops provider continuation, but Pi still persists the failed tool result with the unwritten state entry as its parent, followed by an aborted assistant message.
4. Reopening the file retains Task A in `getEntries()`, but `getBranch()` starts at the orphan error result and omits Task A and earlier conversation. Reopening alone therefore does **not** recover selected acknowledged history.

`context-coexistence.test.ts` starts with acknowledged state and characterizes the missing-parent chain and lost selected history. A separate native `pi.appendEntry` tool, without Todo or its context projection, reproduces the same disk failure and disconnected history. This is existing host behavior, not a cache-prefix regression. The Todo safeguards prevent the failed mutation from advancing local acknowledged state or being projected in the faulted loaded session, including after `/reload`.

The user explicitly dropped recovery for now and prohibited upstream fixes. No recovery command, checkpoint carryover, branch repair, or automatic reopen guarantee is part of this change. Retain ordinary failure safeguards and this characterization; recovery is deferred, not a release blocker for the cache-prefix scope.

## Compatibility and STOP conditions

The local read-only reference tag `v0.84.1` was inspected: `packages/coding-agent/src/index.ts` exports `buildSessionContext`; its session manager has the same single-entry message conversion and `firstKeptEntryId` projection, stable `getHeader()` identity, and append-before-persist ordering. `ExtensionContext.abort(): void` and readonly branch/header access are present. The revised path avoids the known later `triggerTurn: false` fix entirely. Keep the advertised Pi >=0.84.1 floor; this is source compatibility verification, not an executed full 0.84.1 integration suite. Installed 0.85.1 remains the exercised runtime.

Stop if real-SDK ordering, immediate post-Rollover state, aborted transport, or the serialized-prefix gates fail; if another transform destroys required anchors; or if production edits outside scope become necessary. Unknown checkpoint formats without a usable journal cutoff are unsupported once Todo state exists. Do not compensate with provider payload rewriting, raw session-file writes, private Pi mutation, or silently moving state to the tail. Changes to tool scheduling or checkpoint formats must rerun these gates.
