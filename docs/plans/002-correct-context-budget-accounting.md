# Plan 002: Let Pi own compaction policy

## Status and superseded scope

- **Priority:** P1
- **Status:** DONE — native-only policy implemented and verified; Standards and Spec reviews pass.
- **Baseline:** `614e8b9` on the current branch.
- **Scope:** `packages/pi-context-management` implementation, SDK harness/regressions, README, skill, glossary and ADRs; this plan/index; a patch changeset for `@ian-pascoe/pi-context-management`.

The original audit at `127e85a` found standing context counted twice. The provenance investigation in `a5cb042` exposed outgoing/live-state differences; the user rejected broader request tracking. The small arithmetic fix in `614e8b9` passed 116 package tests and review. The subsequently approved native-only design **supersedes that formula, its fit reservations, and this plan's former narrow file restrictions**. Do not restore the old estimator or treat its preservation as a verification requirement.

## Approved behavior

Pi alone owns context accounting, automatic compaction timing, and recent-history retention through `compaction.enabled`, `reserveTokens`, and `keepRecentTokens`. Remove `contextBudget`, `boundedCheckpoint` sizing, extension-owned 80%/90% warnings/triggers, safety margins, and configurable `tailTokens`.

- Normal automatic and manual compaction—including TUI, SDK, and remote—requests fresh useful Notes and an agent-written Handoff before `context_rollover` commits a checkpoint. No native background summarizer is called.
- Actual native overflow permits immediate Emergency Rollover using saved state, marked stale or absent, rather than another oversized preparation request. Pi owns retry; completed tools are not replayed.
- Cancelled, failed, or unfinished preparation reports noncompletion, leaves the conversation intact, and does not repeatedly nudge or silently fall back to stale state. Acknowledged Notes remain saved.
- Keep standalone `context_rollover` and `/rollover`. Native compaction preparation may decline small or already-compacted windows before hooks run, so `ctx.compact()` alone cannot replace explicit Rollover.
- Ignore obsolete `contextManagement` blocks in global or trusted-project settings with one warning per session load pointing to Pi's native settings. Never edit configuration or block continuation because of legacy values.
- Preserve native checkpoint persistence, complete tool batches, normal transforms, selected-branch History, and fail-closed journal handling. Initial oversized input and later standing-context growth may still reach the provider limit; no independent fit guarantee is added.

This policy is recorded in [package ADR-0002](../../packages/pi-context-management/docs/adr/0002-let-pi-own-compaction-policy.md). [ADR-0001](../../packages/pi-context-management/docs/adr/0001-use-native-compaction-checkpoints.md) remains authoritative for persistence and adapter invariants.

## Implementation gates

1. **Prove scheduling before deletion.** Use the real SDK seam with scripted model streams and network guards. Cancelling `session_before_compact` does not cancel the pending automatic request. Verify both active/post-run preparation and idle pre-prompt ordering, preserving incoming instructions. Do not await a future agent turn or recursively compact inside the hook.
2. **Replace policy, retain invariants.** Request preparation once, suppress threshold checks while it is pending, and report noncompletion without stale fallback. Use native preparation cut points or public native cut-point selection with native retention settings; retain complete-group validation, not a second sizing algorithm.
3. **Cover each public path.** Exercise normal automatic preparation, TUI/SDK/remote manual redirects, explicit Rollover, cancellation/noncompletion, overflow, settings migration, checkpoint resume, transforms, and no completed-tool replay. A redirected SDK `compact()` call rejects with native cancellation while preparation proceeds asynchronously; it is not an immediate checkpoint result.
4. **Document and release.** Update package README, skill, glossary, ADR, and patch changeset. Remove obsolete current-policy claims; historical changelog entries remain historical.
5. **Verify and review.** Run typechecks and focused test files regularly, the full package suite at the end, scoped lint/format and whitespace checks. Review Standards and Spec independently against fixed `614e8b9` and this latest approved behavior. Commit on the current branch; do not push or open a PR without authorization.

The real-SDK scheduling proof passed for active/post-run steering and idle pre-prompt `nextTurn` delivery, without nested prompts or provider requests. Final verification passed 131 Context Management tests and 15 Todo tests, both package typechecks, scoped lint/format, and whitespace checks. Standards and Spec reviews against `614e8b9` have no remaining findings. Review regressions cover unfinished-refresh suppression across later prompts, queued cancellation, cancellation-status write quarantine across reload, unrestricted native manual instructions, and truncated-response resume consistency.

## Commands

Run installed binaries from the repository root; do not install dependencies incidentally.

```bash
# Focused workflow regression
./node_modules/.bin/vitest run --config "$PWD/vitest.config.ts" --root packages/pi-context-management test/native-refresh.test.ts
# Regular typecheck
./node_modules/.bin/tsc --noEmit -p packages/pi-context-management/tsconfig.json
# Full package suite at completion
./node_modules/.bin/vitest run --config "$PWD/vitest.config.ts" --root packages/pi-context-management
# Scoped checks
./node_modules/.bin/oxlint packages/pi-context-management/src packages/pi-context-management/test
./node_modules/.bin/oxfmt --check packages/pi-context-management docs/plans/002-correct-context-budget-accounting.md docs/plans/README.md
git diff --check
```

## Completion checklist

- [x] User approved native-only policy and broadened scope.
- [x] Bounded real-SDK scheduling proof covers active/post-run and idle pre-prompt ordering.
- [x] Native-only implementation and integrated lifecycle regressions pass.
- [x] Full package suite, typecheck, lint/format, and whitespace checks pass.
- [x] README, skill, glossary, ADR, plan/index, and patch changeset match verified behavior.
- [x] Standards and Spec reviews pass against `614e8b9` and the approved design.
- [x] Current-branch commit created; no push or PR.

## Stop conditions

Stop for a scheduling/deadlock blocker, loss of incoming instructions, unsafe tool-batch cut, persistence regression, real provider request, or required upstream/dependency change. Do not reopen exact-request/provenance engineering or replace native policy with a new custom estimator. A cancelled preparation is a reported noncompletion, not permission to discard History or retry stale state.

Plan 006's durable custom-budget-warning work is superseded by deleting that warning policy; it is not a follow-on implementation dependency.
