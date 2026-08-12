# Show Child Agent Runtime Profiles in status and the TUI widget

**Status:** Ready for implementation

## Outcome

Expose each Child Agent's current **Runtime Profile**—canonical `provider/model` plus resolved thinking level—in coordinator status and in the transient multiline Subagents widget.

The widget row grammar is:

```text
╰─ ● agent-id  ·  running 12s  ·  provider/model:thinking  ·  task
```

Use the existing dim middle-dot separator and hierarchy/status styling. Show the live Runtime Profile while a Child Agent runtime exists; otherwise fall back silently to the immutable profile in its Launch Contract.

Read before implementation:

- [`../../packages/pi-minimal-subagents/CONTEXT.md`](../../packages/pi-minimal-subagents/CONTEXT.md)
- [`../agents/domain.md`](../agents/domain.md)
- [`../../packages/pi-minimal-subagents/src/minimal-subagents-types.ts`](../../packages/pi-minimal-subagents/src/minimal-subagents-types.ts)
- [`../../packages/pi-minimal-subagents/src/minimal-subagents-sessions.ts`](../../packages/pi-minimal-subagents/src/minimal-subagents-sessions.ts)
- [`../../packages/pi-minimal-subagents/src/minimal-subagents-coordinator.ts`](../../packages/pi-minimal-subagents/src/minimal-subagents-coordinator.ts)
- [`../../packages/pi-minimal-subagents/src/minimal-subagents-ui.ts`](../../packages/pi-minimal-subagents/src/minimal-subagents-ui.ts)

`Runtime Profile` is already defined in the package glossary. This change is reversible and needs no ADR.

## Boundaries

- Keep the Root Agent, compact footer, widget mount/cooldown lifecycle, hierarchy selection, row limit, recent-agent limit, and one-second refresh unchanged.
- Keep one non-wrapping row per visible Child Agent and show the Runtime Profile on structural ancestor rows as well as running/recent rows.
- Keep Launch Contracts immutable. Runtime Profile changes do not update Registry records, survive reload, alter restoration, or change nested spawn defaults.
- Keep detailed status's `launch_contract` as the original profile. Existing unqualified `model` and `thinking_level` summary fields become the best-known Runtime Profile.
- Add no setting or configuration switch.

## Implementation sequence

### 1. Add a live Runtime Profile seam

Update `minimal-subagents-types.ts`:

- Define a `RuntimeProfile` value containing canonical `model` and resolved `thinking_level`.
- Keep `AgentSummary.model` and `AgentSummary.thinking_level` structurally compatible, preferably by having the summary share the Runtime Profile shape.
- Add a synchronous `ChildAgentRuntime` method that returns its current Runtime Profile, or `undefined` when no live model is available.

Update `PiChildAgentRuntime` in `minimal-subagents-sessions.ts`:

- Read `session.model` and `session.thinkingLevel` on every call rather than caching launch values.
- Build the model as `${provider}/${id}`.
- Return `undefined` if the SDK session currently has no model so the coordinator can use its Launch Contract fallback.

This seam is observational. Do not subscribe to model/thinking events, persist a second profile, or change SDK session creation/restoration.

**Complete when:** a runtime exposes its current canonical model and thinking level synchronously, and all `ChildAgentRuntime` implementations/test doubles satisfy the new contract.

### 2. Make coordinator status use the best-known profile

Update `buildAgentSummary()` in `minimal-subagents-coordinator.ts`:

1. Read the Child Agent's live Runtime Profile from `this.runtimes` when present.
2. Fall back to `agent.launch_contract.model` and `agent.launch_contract.thinking_level` during initialization, after disposal, or for unavailable agents.
3. Populate the existing summary `model` and `thinking_level` fields from that selected profile.

Because `status()` and `inspectStatus()` both use this summary builder, direct-child status, detailed status, and the trusted hierarchy projection must agree immediately without a separate cache. `buildAgentDetail()` must continue to expose the unchanged `launch_contract` beside the live summary fields.

Leave `snapshotChildCaller()` on Launch Contract values. An omitted model or thinking level in a nested spawn must retain today's inheritance behavior even when the parent's live Runtime Profile has diverged.

**Complete when:** all status paths report live values for an open runtime, contract values otherwise, detailed status preserves both views, and nested spawn defaults still derive from the Launch Contract.

### 3. Project and render Runtime Profiles in widget rows

Update `minimal-subagents-ui.ts`:

- Carry each summary's Runtime Profile into `MinimalSubagentsWidgetRow` for every chosen row, including structural ancestors.
- Render segments in this order:
  1. hierarchy branch, status symbol, and Child Agent ID;
  2. colored status label plus muted duration separated by one ordinary space;
  3. muted `provider/model:thinking`;
  4. muted single-line task.
- Omit duration when status is `unavailable`, because `elapsed_ms` then describes the previous turn. For other statuses, render `<status> <duration>` when duration exists and `<status>` otherwise.
- Preserve model IDs that already contain colons; append the thinking level as the final recognized suffix.

Implement responsive degradation with ANSI-safe width accounting and no wrapping:

1. Render the complete row.
2. If it does not fit, remove the task as a whole.
3. If it still does not fit, shorten only the model component while preserving the complete `:${thinking}` suffix; the shortest profile form is `…:${thinking}`.
4. If even that form does not fit, remove the duration and recompute the largest profile representation that fits.
5. Only then apply whole-row tail truncation as the last resort.

Keep the canonical model when space permits. Perform width allocation on plain segment content or with Pi TUI's ANSI-aware helpers so theme escape sequences never affect breakpoints. The profile is secondary information and uses muted styling; identity and semantic status colors remain unchanged.

**Complete when:** ordinary-width rows follow the agreed grammar, narrow rows sacrifice task then model detail then duration, the thinking suffix survives profile shortening, and every rendered line remains within terminal width.

### 4. Characterize live status and responsive rendering

Update `test/coordinator.test.ts`:

- Extend `childRuntime()` with a controllable Runtime Profile.
- Prove `status()` and `inspectStatus()` return a runtime profile that differs from the Launch Contract.
- Prove detailed status retains the original values in `launch_contract`.
- Prove status falls back to the Launch Contract before runtime initialization and for an unavailable agent.
- Prove `snapshotChildCaller()` still returns Launch Contract defaults after the live Runtime Profile diverges.

Update `test/ui.test.ts`:

- Supply Runtime Profiles in projected row fixtures.
- Assert the full row segment order and exact `model:thinking` grammar at a wide width.
- Assert structural rows also include their profile.
- Assert status and duration form one segment and unavailable rows omit duration.
- Add breakpoint cases proving the degradation order: task omission, model shortening with the final thinking suffix intact, duration omission, and final bounded truncation.
- Include a model ID containing an existing colon and retain the existing ANSI-safe `visibleWidth` bound assertion.

Update any affected fixtures in the package test suite. Keep rendering tests deterministic with an identity theme; do not require a real TUI, model credential, Pi settings file, or timer beyond the existing fake-timer controller tests.

**Complete when:** tests fail if status uses stale Launch Contract values while a runtime exists, if inheritance begins using live values, if row segments are reordered, or if narrow output loses the thinking suffix before the last-resort truncation case.

### 5. Document and release the behavior

Update `packages/pi-minimal-subagents/README.md` with a concise TUI/status section that states:

- visible Child Agent rows show `provider/model:thinking`;
- status uses the live Runtime Profile when available and the Launch Contract as fallback;
- live changes are observational and do not rewrite persistence or nested spawn defaults.

Add a patch Changeset for `@ian-pascoe/pi-minimal-subagents` describing live Runtime Profiles in status and the widget. Do not edit the package version directly.

**Complete when:** user-facing behavior and the persistence boundary are documented once, and `pnpm changeset:status` recognizes exactly the intended package bump.

### 6. Verify the package and repository

Run in order:

```bash
pnpm format
pnpm --filter @ian-pascoe/pi-minimal-subagents typecheck
pnpm --filter @ian-pascoe/pi-minimal-subagents test
pnpm changeset:status
pnpm verify

git status --short
```

Inspect the final diff to confirm it contains no Registry schema change, Launch Contract mutation, nested inheritance change, permanent widget/footer change, or unrelated formatting churn.

**Complete when:** all commands pass, responsive rows stay width-bounded, status and widget share the same best-known Runtime Profile, and the final diff remains inside the boundaries above.
