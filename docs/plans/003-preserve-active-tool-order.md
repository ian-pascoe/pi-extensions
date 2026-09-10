# Plan 003: Preserve active-tool order during no-op reconciliation

> Execute from the repository root. Read this plan fully, run each gate, and update only this plan's row in `docs/plans/README.md` when verified. This is an implementation handoff, not authorization to push, publish, or alter unrelated work.
>
> Drift check: `git diff --stat 127e85a..HEAD -- packages/pi-minimal-subagents/src/minimal-subagents-access.ts packages/pi-minimal-subagents/src/minimal-subagents-extension.ts packages/pi-minimal-subagents/test/access.test.ts packages/pi-minimal-subagents/test/extension.test.ts packages/pi-mcp/src/mcp-tool-catalog.ts packages/pi-mcp/test/mcp-tool-catalog.test.ts packages/pi-codemode/test/pi-codemode-extension.test.ts`. Compare changed code with the excerpts below before proceeding. Expected changes from another selected plan require explicit reconciliation, not blind application.

## Status

- Priority: P1
- Effort: S
- Risk: LOW
- Depends on: none
- Category: perf / bug
- Planned at: `127e85a`, 2026-09-09
- Execution status: DONE — completion gates and both review axes pass.

## Why this matters

Prompt caching includes tool definitions in their provider-visible order. MCP catalogue synchronization and Subagent Access reconciliation currently regroup already-active tools even when capabilities and definitions have not changed. This unnecessarily changes the reusable prefix after another extension has activated a tool later in the list. Preserve surviving tool order instead of repeatedly normalizing groups.

## Current state and constraints

`packages/pi-minimal-subagents/src/minimal-subagents-access.ts:123–131`:

```ts
const ordinaryToolNames = activeToolNames.filter(
  (toolName) => !COORDINATOR_TOOL_NAME_SET.has(toolName),
);
return enabled ? [...ordinaryToolNames, ...COORDINATOR_TOOL_NAMES] : ordinaryToolNames;
```

`minimal-subagents-extension.ts:849–860` calls this through `applySubagentAccess`, including after `/subagents enable`, reset, and selected-branch tree restoration. A complete enabled set followed by `mcp_late` moves that foreign tool ahead of the Coordinator Tools on an otherwise redundant enable.

`packages/pi-mcp/src/mcp-tool-catalog.ts:604–617`:

```ts
const foreignActiveNames = this.pi
  .getActiveTools()
  .filter((name) => !this.ownedToolNames.has(name));
const ownActiveNames = [
  ...(this.resourceToolsActive ? RESOURCE_TOOL_NAMES : []),
  ...this.registeredServerTools
    .filter(({ prepared }) => this.serverCatalogs.get(prepared.serverId)?.active === true)
    .map(({ name }) => name),
];
const nextActiveNames = [...foreignActiveNames, ...ownActiveNames];
```

An offline execution of the real catalogue reproduced:

```text
[read, mcp__example__echo, foreign_late]
  -- equal fresh catalogue replacement -->
[read, foreign_late, mcp__example__echo]
```

Pi 0.85.1 `dist/core/agent-session.js`, `setActiveToolsByName`, preserves supplied order and rebuilds the base system prompt. Its extension wrapper detects additive activation by membership, not ordering. Therefore do not assert that reordering prevents deferred-tool markers: it changes existing immediate-tool order even when a marker is present. Adding a new alphabetically earlier deferred tool alone is not the demonstrated bug.

Domain constraints:

- `packages/pi-minimal-subagents/CONTEXT.md`: Subagent Access is branch-scoped availability; disabling it must not cancel existing Child Agents or delivery. Launch Contracts remain immutable.
- `packages/pi-mcp/docs/adr/0002-implement-a-complete-mcp-host.md`: removed Server Tools must be deactivated; exact schemas and immediate execution-policy updates are required. Cache preservation must not leave revoked tools callable.
- Repository extensions publish source TypeScript, use explicit `.js` local imports, and test with existing Vitest. Match the pure function/property tests in `test/access.test.ts` and `RecordingPi`/`RecordingRuntime` in MCP's `test/mcp-tool-catalog.test.ts`. Do not create a generic ordering framework or new dependency.

## Scope

Only modify:

- `packages/pi-minimal-subagents/src/minimal-subagents-access.ts`
- `packages/pi-minimal-subagents/src/minimal-subagents-extension.ts` (only skip an identical active-name application, if needed)
- `packages/pi-minimal-subagents/test/access.test.ts`
- `packages/pi-minimal-subagents/test/extension.test.ts` (existing lifecycle harness)
- `packages/pi-mcp/src/mcp-tool-catalog.ts`
- `packages/pi-mcp/test/mcp-tool-catalog.test.ts`
- `packages/pi-codemode/test/pi-codemode-extension.test.ts` (coexistence regression only)
- This plan and its status row in `docs/plans/README.md`

Out of scope: identity/name collision algorithms, schema canonicalization, child access policy, tool execution, MCP instruction snapshots, CodeMode production exposure rules, upstream Pi, manifests, lockfile, and release/version files.

## Commands

Run from the repository root using installed binaries. Do not install automatically: a prior `pnpm exec` invocation ran preparation and refreshed ignored reference repositories.

```sh
./node_modules/.bin/vitest run --config "$PWD/vitest.config.ts" --root packages/pi-minimal-subagents test/access.test.ts test/extension.test.ts
./node_modules/.bin/vitest run --config "$PWD/vitest.config.ts" --root packages/pi-mcp test/mcp-tool-catalog.test.ts
./node_modules/.bin/vitest run --config "$PWD/vitest.config.ts" --root packages/pi-codemode test/pi-codemode-extension.test.ts
./node_modules/.bin/tsc --noEmit -p packages/pi-minimal-subagents/tsconfig.json
./node_modules/.bin/tsc --noEmit -p packages/pi-mcp/tsconfig.json
./node_modules/.bin/tsc --noEmit -p packages/pi-codemode/tsconfig.json
./node_modules/.bin/oxlint packages/pi-minimal-subagents/src/minimal-subagents-access.ts packages/pi-minimal-subagents/src/minimal-subagents-extension.ts packages/pi-minimal-subagents/test/access.test.ts packages/pi-minimal-subagents/test/extension.test.ts packages/pi-mcp/src/mcp-tool-catalog.ts packages/pi-mcp/test/mcp-tool-catalog.test.ts packages/pi-codemode/test/pi-codemode-extension.test.ts
```

Each must exit 0 at completion. Format-check the modified files with `./node_modules/.bin/oxfmt --check <modified-file-paths>`. If dependencies are missing, stop rather than run installation or reference synchronization.

## Steps

### 1. Characterize the no-op and partial-activation cases

Extend the two existing unit harnesses before production changes:

- All Coordinator Tools present, interleaved with ordinary tools: enable returns the exact original ordered list.
- Partial enabled group: existing names retain positions; only missing Coordinator Tools are appended in `COORDINATOR_TOOL_NAMES` order.
- Disable removes only Coordinator Tools and preserves surviving order.
- MCP: establish a catalogue, register a foreign tool afterward, then replace the catalogue with equal freshly allocated definitions. The active ordered list must be identical.
- Change Resource-tool activation, remove a Server Tool, and reactivate one: retain the relative order of survivors; append newly active owned tools deterministically.

**Verify:** Run the first two test commands. New preservation cases must fail on the original implementation for ordering, while existing capability-removal behavior stays green. Record the expected red assertions; do not weaken them into set equality.

### 2. Preserve existing names; append missing names

For Subagents, when enabling, retain existing names and append missing Coordinator Tools. Preserve the current handling of duplicate Coordinator Tool names: keep their first occurrence, not repeated copies. Do not unnecessarily normalize foreign-tool duplicates or reorder unrelated entries. Disabling remains an owned-name filter. If `applySubagentAccess` would apply an identical ordered list, it may return without calling `setActiveTools`.

For MCP, compute the desired owned-name set using the current `ownActiveNames` calculation. Filter the current active list only to remove owned names no longer desired. Keep foreign names and surviving owned names in place. Append desired owned names not already retained, using the existing deterministic desired order. Retain the existing equality guard before `setActiveTools`.

**Verify:** The first two test commands must pass, including no-op order equality, repeated calls, missing-tool additions, Resource tools, and revocation cases.

### 3. Exercise lifecycle and combined exposure

Use the existing Subagents extension harness to verify redundant enable/reset does not alter the active tool sequence or cancel children. Extend the existing CodeMode integration harness with MCP-like and foreign dynamic tools, testing both standalone direct exposure and CodeMode policy. Assert stability of the effective provider-visible immediate definitions and system prompt for a no-op. Compare `name`, `description`, and `parameters`, not function identity or UI callbacks.

Do not demand that genuinely new tools produce identical full requests. For supported native deferral, verify the sequence of previously immediate tools remains unchanged; for other models, a real addition may legitimately change the schema prefix.

**Verify:** All three test commands, all typechecks, lint and modified-file format checks exit 0. No real network/model calls are required.

## Done criteria

- [x] Both reproduced no-op reorder cases now return the identical ordered active names.
- [x] Partial enable, disable, resource activation, removal, and reactivation tests pass.
- [x] No old immediate tool changes relative position solely because a catalogue is refreshed.
- [x] Standalone and CodeMode coexistence cases pass.
- [x] All listed completion commands exit 0; `git diff --check` exits 0.
- [x] `git diff --name-only` and `git status --short` show no implementation changes outside scope attributable to this task.
- [x] Index row updated with verification evidence.

## Git workflow and STOP conditions

Work on the operator-selected branch; never reset unrelated changes. No automatic commit, push, PR, or publication. If later authorized to commit, match repository style, e.g. `fix(pi-mcp): preserve active tool order on catalogue refresh`.

Stop if the lifecycle harness has moved, preserving order requires changing capability semantics or upstream Pi, or CodeMode continually overrides the desired order in a way requiring production policy changes. Report the exact conflicting case. Stop after two unsuccessful attempts at a verification gate rather than removing regression assertions.

## Execution evidence

Implemented from `3f18c1e` on the operator-approved `fix/preserve-active-tool-order` branch. The specified drift check against `127e85a` was empty. Production changes are confined to the two existing reconciliation functions; no Subagent Access lifecycle or CodeMode production policy changes were needed.

- **Red:** Subagent Access had two ordered-list failures: redundant enable regrouped interleaved tools, and partial enable moved existing Coordinator Tools. The other 34 focused tests passed. MCP had three ordering failures: equal fresh refresh moved a late foreign tool, Resource activation moved surviving Server Tools, and removal/replacement moved a foreign tool ahead of a survivor. Its other nine tests passed.
- **Green:** all listed focused commands pass: 36 Subagent Access/lifecycle tests, 12 MCP catalogue tests, and 31 CodeMode extension tests. Existing lifecycle tests cover repeated enable/reset without child cancellation, selected-branch restoration, and continued delivery after disabling access.
- **Coexistence:** the real MCP catalogue runs through the existing Pi SDK fixture with and without CodeMode. Repeated no-op snapshots compare ordered `name`, `description`, and `parameters` plus the effective system prompt. An actual wrapped loader supplies `addedToolNames` to Pi's native deferred-tool splitter: supported deferral retains the exact previous immediate sequence; fallback exposes the addition while preserving survivor order. No network/model calls are required.
- **Gate correction:** two initial CodeMode attempts failed on dynamic-import resolution and an overly strict fallback expectation that a real addition must be globally last. CodeMode legitimately keeps its controls last. The operator authorized retaining the corrected survivor-order assertion and continuing after the stop gate; exact no-op and native-immediate comparisons were not weakened.
- **Completion:** all three package typechecks, the listed lint command, modified-file format checks, and whitespace checks pass. The full workspace suite passes **1,069 tests across 107 files in 15 packages**, using installed binaries after building Pi Utils. Only scoped files changed. Standards and Spec reviews against `3f18c1e` each report zero findings. Commit is authorized; push/publication is not.

## Maintenance notes

Tests must protect order as well as membership. Deterministic sorting is appropriate for newly appended tools, not a reason to move existing ones. Fresh object allocation with identical serialized definitions is not independently a cache defect. Plans 004 and 005 address distinct description/system changes and must not be smuggled into this diff.
