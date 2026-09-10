# Plan 005: Remove redundant tool-roster churn from MCP Instruction Snapshots

> **Executor instructions:** Read this plan fully, preserve its explicit instruction-authority and lifecycle boundaries, and run each verification gate. Update this plan's row in `docs/plans/README.md` when done unless the reviewer maintains it.
>
> **Drift check:** `git diff --stat 127e85a..HEAD -- packages/pi-mcp packages/pi-codemode`. Reconcile the expected Plan 003 ordering and Plan 004 CodeMode changes before proceeding. Stop for any unexplained change to instruction publication or request hooks.

## Status

- **Priority:** P2
- **Effort:** M
- **Risk:** MED — catalogue readiness, instruction authority, and asynchronous startup must remain correct.
- **Depends on:** Plans 003 and 004 in `docs/plans/README.md`; they remove independent tool-order and CodeMode-description mutations that could otherwise obscure integration results.
- **Category:** perf
- **Planned at:** commit `127e85a`, 2026-09-09

## Why this matters

MCP currently duplicates every model-ready Server Tool name in a system-prompt Instruction Snapshot. Adding/removing a tool changes this system text even if the MCP Server provides no instructions, or its real instructions remain identical. Tool definitions already provide the callable names. The duplicate roster creates another early-prefix mutation, sometimes later than the actual tool activation.

Remove the generated roster while retaining genuine Server Instructions, deterministic server attribution, and existing activation gates. This fixes redundant system-text churn; real direct tool-schema changes and real Server Instruction changes can still legitimately reduce cache reuse.

## Explicit timing and authority decision

Use the current public, provider-neutral **agent-start snapshot boundary** in this plan:

1. MCP Servers keep starting in the background without blocking Pi startup or input.
2. At `before_agent_start`, read the latest eligible Instruction Snapshot and append it to the chained system prompt exactly as today.
3. Within that agent run, do not rewrite that snapshot on every tool-loop request. The next agent start takes a fresh snapshot, including genuine changes and completed deactivations.
4. Tool execution authorization/catalogue activation remains live and authoritative independently; do not keep removed tools callable to preserve prompt bytes.
5. Do not move Server Instructions into user/custom messages, change their current role/authority, freeze them for an entire session, or emit provider-specific system-message payloads.

**Known limitation, not a solved claim:** An MCP Server can activate, deactivate, or change its instructions during a tool loop while that run retains its earlier system snapshot. This is already how `before_agent_start` works. This plan intentionally does not promise atomic per-provider-request tool/instruction transitions.

`CONTEXT.md`, README, and ADR-0002 currently promise a stronger per-request atomic snapshot than the implementation provides. Amend them explicitly to the above existing boundary, including the limitation; do not silently relabel it as a fix. If the operator requires the stronger atomic behavior, mark this plan **BLOCKED** pending an approved separate request-lifecycle design. Do not improvise private Pi mutation, provider rewriting, delayed revocation, or lower-authority messages to claim both properties. The roster removal can be reviewed independently of that larger decision.

## Current state

Files below are under `packages/pi-mcp/` unless otherwise noted.

- `src/mcp-host.ts:741–759` constructs snapshots:

  ```ts
  const sections = [...this.entries.values()]
    .filter((entry) => entry.toolCatalogReady)
    .sort((left, right) => left.definition.id.localeCompare(right.definition.id))
    .flatMap((entry) => {
      const instructions = entry.instructionText?.trim();
      const toolNames = [...entry.instructionToolNames].sort();
      if (instructions === undefined && toolNames.length === 0) return [];
      return [
        [
          `## MCP Server: ${entry.definition.id}`,
          instructions === undefined ? undefined : instructions,
          toolNames.length === 0 ? undefined : `Tools: ${toolNames.join(", ")}`,
        ]
          .filter((line): line is string => line !== undefined)
          .join("\n"),
      ];
    });
  return { text: sections.join("\n\n") };
  ```

- `src/pi-mcp-extension.ts:1052–1055` registers `before_agent_start` for instructions and `context` for immutable saved MCP Prompt expansion. Around 1077–1088:

  ```ts
  this.startRuntime(activeSession, context);
  const snapshot = activeSession.runtime.instructionSnapshot();
  return snapshot === undefined || snapshot.length === 0
    ? undefined
    : { systemPrompt: `${systemPrompt}\n\n${snapshot}` };
  ```

- `src/mcp-host.ts:783–805` awaits catalogue synchronization before publishing/clearing host instruction state. `publishInstructionSnapshot` and `clearInstructionSnapshot` near 1004–1020 maintain `toolCatalogReady` and snapshot versions. Keep those gates, including debounced disconnect handling.
- `test/mcp-host.test.ts:777–819` uses fake clients, clocks, and deferred catalogue synchronization to verify readiness and delayed deactivation. Tests around 957–990 currently require the snapshot to change from `current_tool` to `next_tool`.
- `test/pi-mcp-extension.test.ts:132–184` uses a real ExtensionRunner with a fake MCP session. It exercises successive `emitBeforeAgentStart` calls but inaccurately calls them every “turn”; it does not establish per-provider-request refresh.
- `CONTEXT.md` defines **Server Instructions** as server-provided guidance, not Pi policy, and **Instruction Snapshot** as immutable/deterministically ordered. Keep this vocabulary; revise only its inaccurate timing/atomicity sentence.
- ADR-0002 intentionally accepts startup responsiveness over identical early prompts, exact Server Tool schemas, no package-owned permission policy, and no provider payload rewriting. Preserve those decisions. Native deferred tool additions work only on supported Pi/provider/model combinations; do not assert every addition breaks cache or every provider supports deferral.

## Scope

**Only these implementation/documentation files may change:**

- `packages/pi-mcp/src/mcp-host.ts`
- `packages/pi-mcp/test/mcp-host.test.ts`
- `packages/pi-mcp/test/pi-mcp-extension.test.ts`
- `packages/pi-mcp/test/mcp-instruction-cache.test.ts` — optional new file only if the existing fixture cannot host the offline serializer case clearly.
- `packages/pi-mcp/README.md`
- `packages/pi-mcp/CONTEXT.md`
- `packages/pi-mcp/docs/adr/0002-implement-a-complete-mcp-host.md`
- This plan's status row in `docs/plans/README.md`.

**Out of scope:** production `pi-mcp-extension.ts` hook changes; changes to tool activation/order (Plan 003), CodeMode production code (Plan 004), transports, client pooling, sampling, elicitation, auth, retries, schema validation, saved Prompt replay, Resource notices, model options/cache retention, provider adapters, changesets, and release/version work. Production instruction publication remains at the existing hook.

## Commands you will need

Run at the repository root against installed dependencies. Avoid installs, CLI builds, and `pnpm exec` during implementation verification; the audited pnpm launcher unexpectedly ran preparation/reference synchronization.

| Purpose                         | Command                                                                                                                                                                                                      | Expected result                                            |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| Focused baseline/tests          | `./node_modules/.bin/vitest run --config "$PWD/vitest.config.ts" --root packages/pi-mcp test/mcp-host.test.ts test/pi-mcp-extension.test.ts test/mcp-tool-catalog.test.ts`                                   | All pass before changes and after implementation           |
| New serializer file, if created | `./node_modules/.bin/vitest run --config "$PWD/vitest.config.ts" --root packages/pi-mcp test/mcp-instruction-cache.test.ts`                                                                                  | All pass; nonempty captured payloads, zero transport calls |
| Package tests                   | `./node_modules/.bin/vitest run --config "$PWD/vitest.config.ts" --root packages/pi-mcp`                                                                                                                     | All pass                                                   |
| CodeMode coexistence            | `./node_modules/.bin/vitest run --config "$PWD/vitest.config.ts" --root packages/pi-codemode test/pi-codemode-extension.test.ts`                                                                             | All pass, including Plan 004's stable execute contract     |
| Typecheck                       | `./node_modules/.bin/tsc --noEmit -p packages/pi-mcp/tsconfig.json`                                                                                                                                          | Exit 0                                                     |
| Lint                            | `./node_modules/.bin/oxlint packages/pi-mcp/src packages/pi-mcp/test`                                                                                                                                        | Exit 0                                                     |
| Formatting                      | `./node_modules/.bin/oxfmt --check packages/pi-mcp/src/mcp-host.ts packages/pi-mcp/test packages/pi-mcp/README.md packages/pi-mcp/CONTEXT.md packages/pi-mcp/docs/adr/0002-implement-a-complete-mcp-host.md` | Exit 0                                                     |
| Scope                           | `git diff --name-only; git ls-files --others --exclude-standard`                                                                                                                                             | Only allowed files beyond operator's pre-existing work     |

## Steps

### 1. Capture the current baseline and write the failing roster tests

Run the focused baseline. Extend `test/mcp-host.test.ts` using its existing `FakeClient`, `FakeFactory`, clock, and synchronization gates:

- A ready Server with tool names but undefined, empty, or whitespace-only Server Instructions yields an empty snapshot.
- Nonempty instructions yield exactly the attributed server heading plus the existing trimmed instruction content, with no generated tool-name roster.
- With identical instructions and unchanged active-server membership, adding, replacing, reordering, or removing some tools leaves snapshot text byte-identical.
- Two servers becoming ready in opposite orders produce the same sorted final snapshot.

Retain the blocked-initial-sync, failed-sync, inactive-catalogue, delayed-disconnect, and full-deactivation scenarios. Full server deactivation with real instructions must still change the next eligible snapshot; it is not a no-op.

**Verify:** focused command → new no-roster/equality cases fail on `Tools: ...`; existing readiness/failure cases pass. Do not count an unrelated fake-clock timeout as the expected failure.

### 2. Remove roster text without weakening readiness

Modify only `McpHost.instructionSnapshot`'s rendering initially:

- Keep `toolCatalogReady` filtering and deterministic server-ID ordering.
- Skip a section unless `entry.instructionText?.trim()` is nonempty.
- For included sections, retain the server heading and instruction bytes under the existing trim behavior.
- Do not emit `Tools:`, tool counts, version counters, connection status, timing, or a placeholder section for servers without guidance.

Do not rename tools or rewrite Server Instructions. Do not change catalogue publication/versioning, async gates, or when clients read tool catalogues merely because their names are no longer rendered. `instructionToolNames` storage may become write-only; leave that cleanup out if deleting it would touch publication/control flow or unrelated tests. The cache fix does not need a lifecycle refactor.

Replace the existing test “updates Instruction Snapshot tool names after catalog synchronization” with a test that asserts exact same real-instruction text across the catalogue transition, while separately observing that catalogue synchronization occurred and capabilities actually changed.

**Verify:** focused tests plus typecheck → exit 0. Snapshot no longer contains a generated roster; host activation/deactivation tests still pass.

### 3. Lock the authority, timing, and serialized-prefix boundaries

In `test/pi-mcp-extension.test.ts`, rename the lifecycle test to “reads current instructions at each agent start without blocking startup.” Count `instructionSnapshot` calls. Exercise an initial start, instruction availability, repeated `context` events during the same run, and another `before_agent_start` call. Assert:

- Snapshot is captured at agent start only, not at each `context` event.
- Genuine new/changed/removed instructions affect the next agent-start result.
- The previous chained system prompt is retained and the returned role/placement remains the system suffix; custom/user messages are not introduced.
- An unchanged returned instruction string yields byte-identical system text across starts.
- Saved MCP Prompt expansion stays deterministic and does not get regenerated from live server data.

Add a transport-free serializer regression in this file or the optional `mcp-instruction-cache.test.ts`. Serialize fixed synthetic history and the extension's chained system output through the installed Pi AI Anthropic adapter. Supply a fake client and `onPayload` capture that throws a sentinel before transport; assert the payload was captured and no transport was attempted. Resolve the adapter relative to the installed package, not a hardcoded pnpm path; production code must not gain private-provider imports.

For a roster-only catalogue change, assert identical provider `system` blocks. Compare unchanged surviving immediate tool definitions separately. If the tested server tool is directly exposed, its real new/removed schema can change the `tools` section: explicitly allow that expected difference rather than claiming full request-cache preservation. For a discovery-only/CodeMode-only exposure scenario with stable outer tools, compare both `system` and `tools` exactly, relying on the Plan 004 stable-description contract. Add fake/no-op catalogue refresh controls using Plan 003's preserved order.

**Verify:** focused/new-file tests, package tests, and CodeMode coexistence command → all pass. These are offline prefix/serialization guarantees, not live cache-hit measurements. STOP if the serializer seam needs new dependencies, production monkeypatching, or live credentials.

### 4. Document the exact guarantee and complete validation

In README **Host behavior**, `CONTEXT.md` **Instruction Snapshot**, and ADR-0002, state:

- Host snapshot eligibility still follows completed catalogue synchronization.
- Pi captures the system snapshot at agent start, and that run retains it during tool-loop requests.
- A later agent start refreshes real guidance; runtime tool activation/revocation can change earlier.
- Roster-only changes no longer affect system instructions.
- Nonblocking startup, real Server Instructions at their current authority, and live tool-policy enforcement are retained.

Explicitly identify the removed stronger claim of per-request atomicity as an existing implementation/documentation mismatch. If the operator rejects this boundary, mark BLOCKED instead of merely editing away the promise. A future atomic instruction-update design needs its own approval and tests; do not fold it into this cache change.

Changesets and release/version work require separate authorization and are outside this plan. A logical commit, only if requested, is `fix(pi-mcp): omit tool rosters from instruction snapshots`. Do not push or create a PR without permission.

**Verify:** all applicable commands in the table succeed. `rg -n 'Before every model request|appear together after catalog activation|changes atomically with catalog' packages/pi-mcp/README.md packages/pi-mcp/CONTEXT.md packages/pi-mcp/docs/adr/0002-implement-a-complete-mcp-host.md` → no obsolete claims (exit 1). Review the scope listing before completion.

## Test plan and done criteria

- [ ] No-instruction Servers contribute no system section, even with active tools.
- [ ] Real nonempty instructions retain server attribution, deterministic ordering, and current authority.
- [ ] Roster-only changes and equal refreshes leave system serialization identical.
- [ ] Completed full deactivation, actual changed guidance, and a different eligible instructed-server set remain observable at the next agent start.
- [ ] Initial/failed/debounced catalogue synchronization behavior remains covered and unchanged.
- [ ] Tool removal takes effect immediately; cache assertions do not mask necessary capability changes.
- [ ] Agent-start versus per-request behavior is directly tested and documented without an atomicity claim.
- [ ] Existing Prompt replay, Resource notices, CodeMode execution, and Plan 003 ordering tests remain green.
- [ ] Lint, typecheck, formatting, tests, and scope gates pass; index status updated by its owner.

## STOP conditions

- The operator requires per-provider-request atomic Server Instruction/tool activation and does not approve preserving the current agent-start boundary.
- The fix would lower instruction authority, delay capability revocation, block startup on remote servers, or bypass another extension's chained prompt.
- Real instruction text changes are being suppressed just to make a cache-equality test pass.
- Removing roster state appears to require changing snapshot version races, client pooling, synchronization, or production hooks outside scope.
- Source/API drift invalidates the excerpts, the offline serializer cannot be isolated safely, or any gate fails twice after focused repair attempts.

## Maintenance notes

Keep catalogue inventory in tools/discovery results rather than duplicating it in system instructions. Treat real server guidance as distinct from host policy and from capability authorization. Never describe exact string equality as proof of a provider cache hit: model, routing, cache lifetime, breakpoint availability, and real tool changes still matter.
