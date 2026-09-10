# Plan 004: Keep CodeMode's public execute description independent of its live Tool Catalogue

> **Executor instructions:** Read this plan completely, follow its gates, and stop on the conditions below. Implement only the listed scope. Update this plan's row in `docs/plans/README.md` when finished unless the reviewer owns the index.
>
> **Drift check:** `git diff --stat 127e85a..HEAD -- packages/pi-codemode`. Compare the excerpts below with live code before editing. Expected changes from Plan 003 must retain its active-tool ordering guarantees; any other behavioral drift needs review.

## Status

- **Priority:** P2
- **Effort:** M
- **Risk:** MED — changing discovery guidance must not make tools undiscoverable or weaken Exposure Modes.
- **Depends on:** Plan 003, active-tool ordering, in `docs/plans/README.md`.
- **Category:** perf
- **Planned at:** commit `127e85a`, 2026-09-09

## Why this matters

CodeMode currently changes the description of an already registered `codemode_execute` tool whenever its generated catalogue changes. Tool descriptions participate in provider prompt prefixes. Even an addition that Pi could represent through native deferred loading can therefore also rewrite an existing immediate tool. This affects catalogue transitions, not every unchanged Cell or request.

Keep the public execute contract stable and obtain live declarations through the already implemented `codemode_search`. This removes CodeMode's redundant prefix mutation; it does not promise that real changes to other directly exposed tools preserve a provider cache.

## Decision and compatibility contract

Adopt **search-based live discovery**, not a frozen copy of the initial inline catalogue and not a new configuration mode.

- Preserve `CODEMODE_EXECUTE_DESCRIPTION`'s execution instructions and append concise, constant discovery guidance: use direct `codemode_search` before a Cell or `tools.codemode_search` inside one; search an intent to find exact flat names, then search an exact name for the complete declaration; call `tools[name](input)`.
- Remove catalogue declarations, `COMPLETE`/`PARTIAL` coverage, and counts from the public execute description entirely, including its first session-start definition.
- Keep the live Tool Catalogue, current synchronization boundaries, search pagination, declaration limits, frozen per-Cell discovery snapshot, and immediate execution-policy enforcement.
- No provider-specific payload rewriting, shared session IDs, or schema-cache implementation.

**ADR impact:** `packages/pi-codemode/docs/adr/0002-bridge-pi-registered-tools.md` states that registry changes affect execution immediately while the next model/CodeMode-access boundary renders a coherent catalogue. Keep that timing and private-seam decision. Amend it to say the catalogue is delivered by discovery results, not rewritten into an immediate tool definition. The README explicitly promises an inline catalogue today; revise that promise. The change incurs a possible discovery call before unfamiliar tool use in exchange for a stable reusable execute contract.

## Current state

- `src/pi-codemode-extension.ts` owns registration, generation state, synchronization, and direct search. Around lines 110–114:

  ```ts
  function catalogueDescription(catalogue: CodeModeToolCatalogue): string {
    const coverage = catalogue.complete
      ? `COMPLETE: all ${catalogue.totalCount} declarations are shown.`
      : `PARTIAL: ${catalogue.shownCount} of ${catalogue.totalCount} declarations are shown. Use \`tools.${CODEMODE_SEARCH_TOOL_NAME}({ query: "<intent>" })\` to discover exact flat names, then search the exact name for its complete declaration.`;
    return `${CODEMODE_EXECUTE_DESCRIPTION}\n\nCurrent CodeMode tool declarations:\n\n${coverage}\n\n\`\`\`ts\n${catalogue.text}\`\`\``;
  }
  ```

- The generation stores `executeDescription: catalogueDescription(initialCatalogue)`; session startup passes it to `createRenderedCodeModeToolDefinitions`. Around lines 559–575, `synchronizeGeneration` does:

  ```ts
  generation.exposure?.refreshToolExposure();
  const decision = generation.exposure?.getDecision() ?? generation.decision;
  const catalogue = renderGenerationCatalogue(generation.captured, decision);
  generation.decision = decision;
  generation.catalogue = catalogue;
  const description = catalogueDescription(catalogue);
  if (description === generation.executeDescription) return;
  generation.executeDescription = description;
  // Builds and re-registers the execute definition with this description.
  ```

- Direct `operations.search` around lines 268–277 already synchronizes the generation and calls `searchCodeModeToolCatalogue(generation.catalogue.searchEntries, input)`.
- The coordinator's `getToolSnapshot` around lines 379–391 already supplies `names` and `searchEntries` for the Cell's snapshot. It must continue to do so.
- `src/codemode-tool-contract.ts:581–608` accepts an execute-description argument; its tool schema, prompt snippet, and guidelines are constant. `src/codemode-tool-rendering.ts` wraps these definitions for UI. Do not refactor those factories just because their argument becomes constant at this call site.
- `test/pi-codemode-extension.test.ts` uses real Pi session collaborators and a Deno execution fixture. Existing tests near 979, 1161, and 1366–1459 require inline declarations. Their useful assertions about discovery, current exposure, and revocation must survive.
- `CONTEXT.md` defines **Tool Catalogue**, **Exposure Mode**, **Cell**, and **Notebook Binding**. Use those names. Code is source TypeScript with explicit local `.js` imports; tests use Vitest `test`/`expect`. Match the existing fixture, not a parallel mocked runtime.

## Scope

**Only these implementation files may change:**

- `packages/pi-codemode/src/pi-codemode-extension.ts`
- `packages/pi-codemode/test/pi-codemode-extension.test.ts`
- `packages/pi-codemode/README.md`
- `packages/pi-codemode/docs/adr/0002-bridge-pi-registered-tools.md`
- This plan's status row in `docs/plans/README.md`.

**Out of scope:** catalogue rendering/search internals; tool schemas and public result shapes; worker permissions, notebook persistence, UI renderers, exposure-policy algorithms, MCP implementation, Pi dependencies, provider adapters, changesets, and release/version changes. Retain potentially now-unused catalogue rendering functionality for a separate measured simplification; do not turn this cache fix into a catalogue redesign.

## Commands you will need

Run from the repository root using installed binaries. Do not run installation, package builds, or plain `pnpm exec`: the audited environment's pnpm launcher performed an implicit preparation/reference-sync step.

| Purpose       | Command                                                                                                                                                                                                                                       | Expected result                                                         |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Focused tests | `./node_modules/.bin/vitest run --config "$PWD/vitest.config.ts" --root packages/pi-codemode test/pi-codemode-extension.test.ts`                                                                                                              | All pass; audited baseline: 29 tests                                    |
| Package tests | `./node_modules/.bin/vitest run --config "$PWD/vitest.config.ts" --root packages/pi-codemode`                                                                                                                                                 | All pass, no live provider calls                                        |
| Typecheck     | `./node_modules/.bin/tsc --noEmit -p packages/pi-codemode/tsconfig.json`                                                                                                                                                                      | Exit 0                                                                  |
| Lint          | `./node_modules/.bin/oxlint packages/pi-codemode/src packages/pi-codemode/test`                                                                                                                                                               | Exit 0                                                                  |
| Formatting    | `./node_modules/.bin/oxfmt --check packages/pi-codemode/src/pi-codemode-extension.ts packages/pi-codemode/test/pi-codemode-extension.test.ts packages/pi-codemode/README.md packages/pi-codemode/docs/adr/0002-bridge-pi-registered-tools.md` | Exit 0                                                                  |
| Scope         | `git diff --name-only; git ls-files --others --exclude-standard`                                                                                                                                                                              | Only approved files, accounting for the operator's pre-existing changes |

## Steps

### 1. Establish the baseline and add the failing contract tests

Run the focused tests before editing. Extend the existing fixture tests with a helper that snapshots the model-facing execute contract: `name`, `description`, `parameters`, `promptSnippet`, and `promptGuidelines`, excluding functions/UI metadata.

Register a tool available only inside CodeMode so the outer direct tool set stays unchanged. Capture the contract after startup, then after a new tool, replacement description/schema, removal, repeated unchanged synchronization, a direct search, and a Cell. Require exact equality. Assert that search nevertheless returns the current complete declaration and a revoked tool remains uncallable, including an already-captured guest callable.

Use a separately configured `direct-and-codemode` fixture to retain coverage of necessary direct-tool changes; do not incorrectly require the entire tool array to remain unchanged there.

**Verify:** focused test command → original cases pass and the new stable-description case fails on catalogue text/count changes. A failure in execution semantics rather than description equality is not the expected red state.

### 2. Remove the dynamic description publication, retaining discovery

In `pi-codemode-extension.ts`, put constant discovery guidance in `CODEMODE_EXECUTE_DESCRIPTION`. Delete `catalogueDescription`, the generation's `executeDescription` field, and only the description-comparison/re-registration tail of `synchronizeGeneration`.

All calls to `createRenderedCodeModeToolDefinitions` in this module must pass the constant description. Keep session-start registration needed to bind renderers/closures, and keep synchronization of `generation.decision` and `generation.catalogue`. Do not delete any synchronization hook merely because it no longer re-registers a tool.

Rewrite the old inline-catalogue tests to assert discovery through direct/in-Cell search and absence of inventory text from the execute description. Preserve the large-catalogue test as discovery-and-call coverage; it no longer needs a `PARTIAL` execute description.

**Verify:** focused tests and typecheck commands → exit 0, including dynamic discovery and immediate revocation cases.

### 3. Prove stable provider-visible definitions without network access

Add an offline serializer regression in the same integration test file. Capture successive Anthropic request payloads from the installed Pi AI adapter by supplying a fake client and an `onPayload` callback that records the payload and throws a sentinel before transport. Resolve the installed adapter relative to the installed `@earendil-works/pi-ai` entrypoint; do not hardcode a pnpm store/version path or add a production import of Pi internals. Use a fixed model, fixed session routing key, fixed standing instructions, and synthetic messages. Assert capture actually ran and no fake transport method was called.

For the CodeMode-only dynamic catalogue scenario, compare the complete serialized outer `tools` and `system` sections byte-for-byte before and after discovery/synchronization. Preserve earlier message content, permitting only newly appended search/tool results. Include an unchanged synchronization control. This is a serialization assertion, not a claim of real cached-token savings.

Pi 0.85.1 supports native deferred additions for some Anthropic/OpenAI models. Do not generalize that all additions bust cache. A changed existing execute definition is the particular mutation this test excludes; unsupported-provider fallback and genuine direct-schema changes remain legitimate.

**Verify:** package tests and typecheck → exit 0; the serializer test checks a nonempty captured payload and explicitly prohibits transport. If the installed adapter seam cannot be exercised without a new dependency or production monkeypatch, STOP rather than replace the test with a message-length assertion.

### 4. Update the documented discovery contract and finish validation

Update README **Registered tools** to describe constant execute guidance, direct discovery before a Cell, and the frozen in-Cell snapshot. Remove claims that tools are omitted from an inline catalogue; all discovery remains bounded by the existing search contract. Amend ADR-0002 with the cache tradeoff and retain its coherent synchronization/immediate policy requirement.

Changesets and release/version work require separate authorization and are outside this plan. Use a logical commit message such as `fix(pi-codemode): keep execute description stable` only if commits were requested. Do not push or open a PR without instruction.

**Verify:** package tests, typecheck, lint, formatting, and scope commands → all succeed. `rg -n 'catalogueDescription|executeDescription:' packages/pi-codemode/src/pi-codemode-extension.ts` → no matches (exit 1).

## Test plan and done criteria

- [ ] Existing execution, cancellation, notebook reuse, hook forwarding, frozen Cell snapshot, and revoked callable tests still pass.
- [ ] Static execute contract is identical across CodeMode-only add/replace/remove/no-op/search/Cell transitions.
- [ ] Direct and in-Cell search can discover and call a tool never present in execute's description.
- [ ] Provider `tools`/`system` serialization remains identical when only the CodeMode-only catalogue changes.
- [ ] Real directly exposed tool changes are permitted and not hidden for a passing cache test.
- [ ] All commands above exit as specified; no live credentials, provider calls, or dependency changes are introduced.
- [ ] README and ADR explain the discovery-call tradeoff; index status is updated by its owner.

## STOP conditions

- Exposure changes no longer take effect immediately, or a previously captured guest function can invoke a revoked tool.
- Search is not available through both documented surfaces with the proposed constant guidance.
- Fixing the regression requires changing public result/schema contracts, catalogue algorithms, worker permissions, provider adapters, or dependencies.
- The operator requires retaining a live inline catalogue: that conflicts with this plan's selected tradeoff and requires a decision, not an invented compatibility toggle.
- The fixture/source differs materially from the excerpts, or a gate still fails after two focused repair attempts.

## Maintenance notes

Keep volatile tool names, counts, schema snippets, session IDs, and timestamps out of immediate CodeMode tool definitions. New discovery features belong in appended search results. Keep distinguishing frozen discovery data from live execution authorization, and never make authorization stale to preserve caching.
