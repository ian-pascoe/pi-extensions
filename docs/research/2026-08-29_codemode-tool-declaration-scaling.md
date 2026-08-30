# CodeMode tool-declaration scaling

**Date:** 2026-08-29  
**Question:** How should Pi CodeMode expose large TypeScript tool catalogs without paying the full declaration cost up front?

## Conclusion

Pi should replace all-eager declarations with a **bounded hybrid progressive-disclosure catalog**:

- Inline a small, OpenCode-style budget (about **2,000 estimated tokens**, using chars/4) of complete declarations.
- Always show compact namespace/group counts and whether the inline list is partial.
- Fairly select entries across groups (round-robin, cheapest signatures first), so one large provider cannot starve others.
- Provide search that returns the **exact registered name and complete declaration** (input/output types and referenced definitions) so discovery does not require a second lookup.
- Expose the same search operation directly and inside CodeMode, allowing discovery before a Cell while preserving per-Cell snapshots during execution.
- Preserve Pi's current **flat, exact registered-name** call model. Grouping in prose must not invent nested paths.
- Keep the existing **1 MiB catalogue limit only as an outer fail-safe**, not as the primary prompt budget.

A first-call schema cache is not a solution: the model still needs a reliable way to discover a tool and construct its first valid call. Caching may reduce repeated work after discovery, but it cannot bound the initial description or solve unknown names.

## Current Pi behavior

The current renderer eagerly emits every non-reserved tool as a TypeScript property:

```ts
readonly ["name"]: (input: Input) => Promise<PiToolResult<Output>>;
```

This shape and catalogue rendering are in `packages/pi-codemode/src/codemode-tool-catalog.ts:293-302,318-333` (local checkout). The extension embeds the resulting text directly in the model-facing execute description (`packages/pi-codemode/src/pi-codemode-extension.ts:44-45,68-70,85-111`).

The renderer has a 1 MiB UTF-8 bound, a 2 KiB per-description bound, and schema-depth 16 (`codemode-tool-catalog.ts:11-13`). When the bound is exceeded it first replaces the largest input/output strings with `unknown`, then removes descriptions; it never omits individual names (`:335-370`). Thus names are all-or-nothing, and a successful 1 MiB description is still an impractical prompt-sized payload.

Approximate growth from the current format:

- Unknown input/output and no description: **~69 + UTF-8 name bytes per tool**. Eight-byte names fit roughly 13.6k tools under 1 MiB; 32-byte names roughly 10.4k.
- A retained 2 KiB description makes a tool about **2.1 KiB before schemas**, so roughly 500 such tools approach 1 MiB.
- Real schemas can add multiple KiB per tool, so practical context limits arrive far before the byte cap.

The runtime does not need these schemas to invoke tools. The execute protocol carries only `toolNames` (`packages/pi-codemode/src/codemode-worker-protocol.ts:43-48`); the worker turns those flat names into callable properties (`packages/pi-codemode/src/codemode-worker.ts:818-868,1196-1200`). The protocol's whole-request line limit is 8 MiB (`codemode-worker-protocol.ts:5,535-541`), so an enormous name set remains a separate transport risk, but removing prompt declarations does not change invocation correctness.

## OpenCode

The vendored OpenCode CodeMode is the closest design precedent. `DiscoveryOptions.catalogBudget` defaults to 2,000 estimated tokens (characters/4) (`.repos/opencode/packages/codemode/src/codemode.ts:19-23`; local ref `dc4449df0d52199704ea4989a5a993ebbc605612`).

Its runtime recursively builds a structured catalogue and search index (`tool-runtime.ts:316-357,451-476`), then `prepare()` selects complete signatures under budget. Namespace stubs/counts remain visible; selection is round-robin across namespaces and favors cheaper signatures, yielding explicit COMPLETE/PARTIAL status and per-namespace coverage (`tool-runtime.ts:484-647`).

A reserved `$codemode.search` tool is always registered. It accepts `query`, optional `namespace`, `limit`, and `offset`; it supports exact path lookup, weighted deterministic matching, namespace browsing, and pagination (`tool-runtime.ts:386-449`). Search returns the exact usable path, description, and complete signature, so no describe round-trip is required. The README documents empty-query namespace browsing and direct use of returned paths (`README.md:180-234`). The design notes describe the same workflow and constraints (`codemode.md:31-61`).

OpenCode has real nested namespaces in its runtime. That is an important distinction: Pi should borrow the budgeted discovery protocol, not copy OpenCode's nested path semantics.

## Executor

The primary Executor comparison is `UsefulSoftwareCo/executor` at commit `1e8ce10e83b8255e2c186b2da9e027871b1a405e` (the relevant product is sometimes referred to as executor.sh). Executor deliberately keeps its always-loaded execute description small: intro, a pointer to the execute skill, and live connected-integration names (`packages/core/execution/src/description.ts:4-39`). The README explains that the full workflow is kept in the skill so models that never execute code do not pay for it (`README.md:102-111`).

Executor uses pure lazy discovery. Its skill says search, then `describe.tool`, then call (`packages/core/execution/src/skills.ts:25-65`). `describe.tool` returns compact `inputTypeScript`, `outputTypeScript`, and referenced definitions (`tool-invoker.ts:129-138`). Search is paged (`:429-460`), token/field weighted (`:588-655`), and supports namespace-scoped browse with an empty query (`:657-732`). The Deno lazy proxy rejects enumeration and directs callers to search (`runtime-deno-subprocess/src/deno-subprocess-worker.mjs:44-58`).

A live smoke test confirmed the behavior: `Object.keys(tools)` throws the lazy-proxy error; namespace empty-query search pages names/descriptions; and `describe.tool` returns compact input/output TypeScript plus referenced definitions. Executor's approach minimizes the initial prompt, but every unfamiliar tool costs a second describe call. Shared definitions can also be very large for one tool; they are merely deferred, not eliminated.

## Comparison

| System     | Initial model surface                        | Discovery result                              | Runtime naming                   |
| ---------- | -------------------------------------------- | --------------------------------------------- | -------------------------------- |
| Current Pi | Every declaration, degraded only after 1 MiB | None                                          | Flat exact names                 |
| OpenCode   | Budgeted complete signatures + group counts  | Exact path + description + complete signature | Nested namespaces are real       |
| Executor   | Small instructions/integration inventory     | Search result, then `describe.tool`           | Lazy proxy; enumeration rejected |

OpenCode is the better target for Pi because it combines bounded initial context with one-step usable discovery. Executor validates the value of keeping workflow prose and schemas out of the always-loaded description, but its second lookup is unnecessary if Pi search can return the whole declaration. OpenCode's nested namespace implementation must not be transplanted into Pi: Pi's worker exposes `tools[name]` for exact flat names, and current protocol/runtime code has no hierarchical aliasing.

## Recommended Pi design

1. **Budget declarations, not names.** Keep all registered names in an internal catalogue/index, but inline only complete entries that fit a small estimated-token budget.
2. **Group fairly.** Group display entries by a stable source/provider or name prefix, always emit counts, and select entries round-robin with deterministic tie-breaking. State COMPLETE/PARTIAL and shown/total counts.
3. **Add a reserved direct and in-Cell discovery callable.** It should accept `query`, optional group/namespace filter, `limit`, and `offset`. Direct search reads the current catalogue; in-Cell search reads that Cell's frozen snapshot. Both should support exact-name lookup, deterministic ranking, and pagination.
4. **Return the full declaration from search.** Include the exact flat registered name plus complete input/output TypeScript and any definitions needed to call it. Preserve bracket notation where names are not identifiers. Add a separate `describe` tool only if search cannot safely return the complete declaration.
5. **Keep invocation unchanged.** Search results must be called through the existing exact flat path (`tools["registered-name"]` or the equivalent generated expression). Display grouping is explanatory only.
6. **Keep 1 MiB as a final guard.** If even the bounded catalog/index metadata cannot fit, fail closed or reduce the inline section; do not use the 1 MiB threshold as the normal budget.

The discovery metadata must use the same exposure snapshot/generation as the callable names. Otherwise search could return a tool that a subsequent bridge rejects after an exposure update. A virtual search tool also needs explicit local handling or a coordinator-approved reserved name; merely adding a declaration does not make the current worker bridge execute it.

## Constraints/risks

- **Flat-name compatibility:** True namespaces require a hierarchical proxy, collision policy, reversible mapping, and protocol changes; they are not a drop-in optimization.
- **Name transport:** Pi's 8 MiB request-line ceiling still bounds extreme tool-name sets, even if schemas are omitted.
- **Schema size:** A single tool's deeply referenced definitions may be large. Bound or truncate individual search results with an explicit incomplete-schema marker rather than silently claiming completeness.
- **Search quality:** Index names, descriptions, parameter names, and parameter descriptions. Exact-name lookup must win over fuzzy ranking; pagination must return stable ordering.
- **Exposure churn:** Rebuild the index with the same active-tool snapshot used for each Cell and reject stale paths clearly.
- **Model instructions:** Advertise the discovery callable consistently. A partial catalog should tell the model how to search and how to call the exact returned name; a complete catalog may still retain the callable for defensive/speculative use.
- **Security/policy:** Discovery must include only tools allowed by the current exposure decision. It must not become a back door to inactive or unregistered tools.
- **Executor trade-off:** Pure lazy discovery is excellent for prompt size, but Executor's search→describe round-trip adds latency and can expose huge shared definitions on demand. Pi can retain the size benefit while avoiding that extra call by returning the complete declaration from search.

## Primary sources

### Pi (local checkout)

- `packages/pi-codemode/src/codemode-tool-catalog.ts:11-13,293-302,318-370` — limits, declaration shape, eager rendering, and degradation.
- `packages/pi-codemode/src/pi-codemode-extension.ts:44-45,68-70,85-111` — execute description and catalogue embedding.
- `packages/pi-codemode/src/codemode-worker-protocol.ts:5,43-48,535-541` — `toolNames` protocol field and 8 MiB line limit.
- `packages/pi-codemode/src/codemode-worker.ts:818-868,1196-1200` — flat exact-name proxy and per-Cell name installation.

### OpenCode (immutable ref `dc4449df0d52199704ea4989a5a993ebbc605612`)

- [`codemode.ts`](https://github.com/anomalyco/opencode/blob/dc4449df0d52199704ea4989a5a993ebbc605612/packages/codemode/src/codemode.ts#L19-L23)
- [`tool-runtime.ts`](https://github.com/anomalyco/opencode/blob/dc4449df0d52199704ea4989a5a993ebbc605612/packages/codemode/src/tool-runtime.ts#L316-L357), [`#L386-L449`](https://github.com/anomalyco/opencode/blob/dc4449df0d52199704ea4989a5a993ebbc605612/packages/codemode/src/tool-runtime.ts#L386-L449), [`#L451-L476`](https://github.com/anomalyco/opencode/blob/dc4449df0d52199704ea4989a5a993ebbc605612/packages/codemode/src/tool-runtime.ts#L451-L476), [`#L484-L647`](https://github.com/anomalyco/opencode/blob/dc4449df0d52199704ea4989a5a993ebbc605612/packages/codemode/src/tool-runtime.ts#L484-L647)
- [`README.md`](https://github.com/anomalyco/opencode/blob/dc4449df0d52199704ea4989a5a993ebbc605612/packages/codemode/README.md#L180-L234)
- [`codemode.md`](https://github.com/anomalyco/opencode/blob/dc4449df0d52199704ea4989a5a993ebbc605612/packages/codemode/codemode.md#L31-L61)

### Executor / executor.sh (`UsefulSoftwareCo/executor`, immutable ref `1e8ce10e83b8255e2c186b2da9e027871b1a405e`)

- [`description.ts`](https://github.com/UsefulSoftwareCo/executor/blob/1e8ce10e83b8255e2c186b2da9e027871b1a405e/packages/core/execution/src/description.ts#L4-L39)
- [`skills.ts`](https://github.com/UsefulSoftwareCo/executor/blob/1e8ce10e83b8255e2c186b2da9e027871b1a405e/packages/core/execution/src/skills.ts#L25-L65)
- [`tool-invoker.ts`](https://github.com/UsefulSoftwareCo/executor/blob/1e8ce10e83b8255e2c186b2da9e027871b1a405e/packages/core/execution/src/tool-invoker.ts#L129-L138), [`#L429-L460`](https://github.com/UsefulSoftwareCo/executor/blob/1e8ce10e83b8255e2c186b2da9e027871b1a405e/packages/core/execution/src/tool-invoker.ts#L429-L460), [`#L588-L732`](https://github.com/UsefulSoftwareCo/executor/blob/1e8ce10e83b8255e2c186b2da9e027871b1a405e/packages/core/execution/src/tool-invoker.ts#L588-L732)
- [`deno-subprocess-worker.mjs`](https://github.com/UsefulSoftwareCo/executor/blob/1e8ce10e83b8255e2c186b2da9e027871b1a405e/packages/kernel/runtime-deno-subprocess/src/deno-subprocess-worker.mjs#L44-L58)
- [`packages/core/execution/README.md`](https://github.com/UsefulSoftwareCo/executor/blob/1e8ce10e83b8255e2c186b2da9e027871b1a405e/packages/core/execution/README.md#L102-L111)

## Decision proposal

Adopt OpenCode's bounded hybrid model for Pi: ~2,000 estimated-token fair inline declarations plus exact full-declaration search available directly and in-Cell, retain flat exact registered names, and leave 1 MiB as a defensive outer limit. Add `describe` only if search cannot provide the complete declaration in one response.
