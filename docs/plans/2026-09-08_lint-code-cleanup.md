# Remove lint workarounds from package code

**Status:** implemented, verified, and reviewed on 2026-09-08, following explicit implementation authorization.

**Planned against:** `3a1bf68`, 2026-09-08. The original audit used `0069ce7`; the checkout now also includes LSP server controls and streamed Context Management previews. Preserve both additions.

## Outcome and agreed limits

Make package code follow the existing lint policy without hiding broad types or prohibited operations behind different spellings. Keep narrowly scoped, explained exceptions where the operation is genuinely necessary. Zero suppression comments is not the target.

- **Change code and tests only:** `src/` and `test/` in `packages/pi-minimal-subagents`, `pi-lsp`, `pi-dap`, `pi-mcp`, `pi-codemode`, `pi-git-checkpoints`, `pi-web-tools`, `pi-todo`, and `pi-context-management`. Limit changes to the findings below and their direct consumers. Small package-local validation or fixture helpers are allowed when reused.
- **Leave machinery untouched:** lint rules, `tools/oxlint/`, `.pi/`, lint/format/TypeScript/test configuration, exclusions, hooks, CI, manifests, lockfiles, dependencies, release files, and generated tool declarations. Do not add lint-rule tests or a new enforcement script.
- Preserve supported historical sessions/settings, tool inputs and outputs, extra historical fields, error handling, and absent-property behavior. Reject values that never met the claimed input contract through the existing failure path.
- Reuse existing types, schemas, and test harnesses. Use a documented partial-fixture cast when full framework construction would be disproportionate. Keep production changes driven by actual contracts, not merely by fixture convenience.
- Keep protocol typing bounded: exact types for owned values, honest `unknown` for data not yet checked, and validation where fields are consumed. A method-by-method LSP typing framework is outside this plan.
- Keep live MCP structured-output handling unchanged. Narrow the historical reader's claimed type rather than validating an unused historical field.

All paths and line anchors below refer to the planned commit. Find the named symbol if lines move.

## 1. Establish the starting point

1. Record `git status --short` and preserve unrelated changes. Compare `git diff --stat 3a1bf68..HEAD -- packages` with this plan before editing.
2. Read `CONTEXT-MAP.md`, the relevant package `CONTEXT.md`, and the ADRs for the boundary being changed. In particular, Minimal Subagents ADR-0004 requires valid Registry V1 migration, V2 validation, local diagnostics for invalid owned records, and silent exclusion of foreign-root records.
3. Enumerate current exceptions with `rg -n '(oxlint|eslint)-(disable|enable)' packages`. Account for each directive when its file is changed: remove it, narrow it, or retain its specific justification.
4. Run the baseline commands below. Keep pre-existing failures separate from regressions introduced by this work.

The read-only planning check found **249 linted files, 126 rules, and ten unused-suppression diagnostics, with no other diagnostics**. The inventory still contains 80 disable directives in 34 files: 17 whole-file directives, one bounded region, and 62 next-line directives. Counts are a starting inventory, not a completion target.

### Verification commands

Use installed binaries directly. During the audit, `pnpm exec … --help` unexpectedly triggered automatic install/prepare, including reference syncing and hook setup. If dependencies are missing, stop and request environment setup instead of installing as part of this cleanup.

From the repository root, in one shell:

```bash
ROOT="$PWD"

check_package() (
  cd "$ROOT/packages/$1" || exit 1
  "$ROOT/node_modules/.bin/tsc" --noEmit -p tsconfig.json &&
  "$ROOT/node_modules/.bin/vitest" run --config ../../vitest.config.ts --root .
)

node_modules/.bin/oxlint
node_modules/.bin/oxlint --report-unused-disable-directives-severity error
```

Ordinary lint should pass at the baseline; the stricter run currently fails on the ten entries listed in step 6. `check_package <package>` mirrors each affected package's existing test/typecheck commands and must pass after its changes. In a new shell/tool invocation, repeat the `ROOT` assignment and function definition together with the desired calls; do not write a helper script into the repository. Use an existing test filename as an additional Vitest filter during iteration; run the whole affected package before completing a step.

**Done:** the working-tree baseline, current directive inventory, and pre-existing verification failures are recorded. Later edits preserve the newer LSP controls and Context Management preview behavior.

## 2. Make validation and type claims agree

### Minimal Subagents: replace empty JSON checks

Start with:

- `src/minimal-subagents-registry-wire.ts:5`: `RegistryJsonValueWireSchema = Type.Unsafe<JsonValue>({})`.
- `src/minimal-subagents-registry.ts:1194–1198`: `Value.Check` uses that empty schema before `parseRegistryEventRecord` and claims to reject non-JSON input.
- `src/minimal-subagents-config.ts:10` and `src/minimal-subagents-settings-writer.ts:67`: the same empty-schema pattern.

An empty schema accepts functions, symbols, `undefined`, and other non-JSON values. A type parameter does not make it a validator.

Registry replay handles both persisted JSON and live records. Current producers legitimately include optional properties whose value is `undefined` (`minimal-subagents-coordinator.ts:239,968–969`); checkpoints preserve them. A strict whole-record JSON check would break those inputs.

Remove the empty-schema narrowing and let the owning parser accept raw `unknown` with a justified local exception. Reuse `parseRegistryEventRecord`'s existing envelope, event, and field schemas to establish the actual Registry contract; do not claim the entire input is already JSON. Keep `RegistryRootProbeWireSchema` ownership filtering first: identifiable foreign-root records must be ignored even when their other fields are malformed. Validate owned data afterward, retaining current diagnostics and optional-field acceptance.

For configuration, likewise replace the empty JSON guarantee with honest raw-input types and the existing field-specific checks. For the settings writer, `parseSettingsDocument` already calls `JSON.parse` before checking the object root; make that provenance explicit rather than adding a second serialization round trip. If a remaining boundary truly needs an arbitrary JSON validator, the existing recursive TypeBox pattern is in `packages/pi-mcp/src/mcp-auth-store.ts:20–34`; use it locally only at that boundary. Every retained type guarantee must have identifiable evidence.

Extend `test/registry.test.ts`, `test/config.test.ts`, and `test/settings-writer.test.ts` as applicable:

- Preserve valid V1/V2 replay, latest-valid-checkpoint fallback, and supported settings behavior.
- Replay original, un-serialized live events and checkpoints containing optional `undefined` fields. Assert the same accepted state; a JSON round trip in the fixture would hide this compatibility requirement.
- Exercise invalid owned fields, including a nested non-JSON value where a checked field requires a concrete type. Rejection must use existing diagnostics rather than crash replay.
- Supply an identifiable foreign-root record with a nested non-JSON value; assert no state change and no diagnostics for it.
- Preserve settings round trips and unrelated JSON fields. Do not rewrite or migrate saved documents as part of lint cleanup.

### MCP: narrow the historical result reader

In `packages/pi-mcp/src/mcp-presentation.ts`, `McpResultDetailsMarkerSchema` at lines 49–52 checks `mcp` and unrestricted `result`, but `parseMcpResultDetails` at lines 290–293 asserts an interface also promising `structuredContent?: JSONValue`.

Return a type describing only the fields the historical reader establishes and its consumers use: the marker and the existing unparsed result metadata. Keep unparsed `result` typed as `unknown`, rather than inheriting `any` from `Type.Any()`; use a matching named contract or an equivalent accepting schema with honest inference. Preserve extra properties and historical input acceptance; narrowing the static view must not strip or mutate the input. Do not turn `result` into a JSON-only contract: its metadata is inspected separately.

Check the parser consumers in `mcp-presentation.ts` and `mcp-tool-catalog.ts`. Keep precise live structured-output types in the tool result construction and `pi-mcp-extension.ts`/`mcp-content.ts` unchanged. If a producer shares the historical reader's interface, separate their static contracts only as needed to retain the producer's stronger guarantee.

Extend `test/mcp-presentation.test.ts` to cover valid and invalid markers, extra historical fields, input preservation, and an extra `structuredContent` field that the reader neither checks nor promises. Keep tool-result error handling and existing live structured-output tests passing.

**Verify:** `check_package pi-minimal-subagents`, `check_package pi-mcp`, and ordinary lint all pass. Registry inputs reach real ownership/field validation without an empty-schema cast, live optional fields remain accepted, and the MCP reader no longer advertises unchecked fields.

## 3. Replace broad types and concealed operations

### LSP: preserve known types, check dynamic data where used

`LSPAny` is an imported alias for `any`, not evidence of validation. Review its uses in `src/lsp-tool.ts`, `lsp-server-client.ts`, `lsp-tool-rendering.ts`, `lsp-tool-output.ts`, `lsp-workspace-edit.ts`, and `test/lsp-tool.test.ts`.

- Replace owned-object widening in `lsp-tool.ts:300,575,1048` using the existing `LspToolResultDetails` union and its operation/preview/apply members. `lsp-tool-contract.ts:401–464` also supplies `LspWorkspaceEditPreviewRecord`, `ServerOperationOutcome`, and their schemas. Keep `previewRecords` precisely typed.
- Give the request object at `lsp-tool.ts:628` its known position/reference-request shape using existing protocol types. Preserve which optional fields each operation sends.
- Replace `Record<string, LSPAny>` and empty `Type.Unsafe<LSPAny>({})` checks at semantic consumption points with the actual consumed contract. Where a value is genuinely unparsed, use `unknown` and a narrowly explained boundary exception; carry opaque data without claiming its fields are safe.
- Update render/count/output paths and test response fixtures so they do not recover arbitrary fields through imported `any`, an unchecked generic, or an equivalent alias. Keep output normalization, result spilling, mixed-server success, and dynamic protocol passthrough behavior intact.
- `isWorkspaceEditPreview` in `lsp-workspace-edit.ts:794–814` claims a complete preview while only checking that `operations` is an array. Reuse the existing preview-record schema or pass an already validated contract through the caller. Preserve full operation validation and replay behavior; merely editing the comment does not repair the local type claim.

Use existing `lsp-tool`, `lsp-tool-contract`, `lsp-tool-rendering`, workspace-edit, and extension tests. Check saved preview replay and malformed operation rejection. Preserve the newer session-aware server controls. If a change needs a comprehensive protocol method map or rejects previously supported protocol payloads, stop and report that scope conflict.

### DAP: remove caller-selected guarantees

In `src/dap-protocol-client.ts`, remove the generic response promise from `request<TBody = unknown>` and the caller-selected subtype from `waitForEvent<TEvent>`. Return the honest raw body/base event contract and remove the corresponding casts at lines 786 and 867. Keep event names, request correlation, cancellation, and timeouts unchanged.

Production callers in `dap-session.ts` already parse consumed bodies through `parseDapBody`; preserve those checks. The internal client is not the package's documented public API. Update the generic test callers in `test/dap-protocol-client.test.ts` to assert actual responses or validate before field access rather than supplying the desired type.

### CodeMode: make necessary boundaries explicit

| Location                                                                         | Required change                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/pi-agent-session-capture.ts:63–66`                                          | Remove the intermediate `object` widening. Use a directly justified compatibility boundary and retain runtime capability checks, fresh registry validation, and exact descriptor restoration.                                                                                                                                                                                                        |
| `src/codemode-worker.ts:80–82`                                                   | Preserve the captured `Reflect.apply`, but add an ordinary policy-exception comment naming `anti-slop/no-reflect-apply` and explaining why capture before guest execution is necessary. The rule does not detect the alias, so a disable directive would be unused. Retain tests against guest mutation; neither a late global lookup nor a contrived call merely to trigger lint is an improvement. |
| `src/codemode-worker.ts:130,135`                                                 | Rename ordinary guest input from `cause` to a truthful name and explicitly justify its `unknown` boundary. Retain non-observable primitive checks. Real error-cause parameters elsewhere remain appropriate.                                                                                                                                                                                         |
| `packages/pi-minimal-subagents/src/minimal-subagents-render-contract.ts:386,420` | Express raw input honestly rather than using an indexed-access spelling to conceal `unknown`; retain the existing per-tool/message schemas and narrow parser exceptions.                                                                                                                                                                                                                             |

Keep null-prototype guest objects, captured built-ins, getter/Proxy protections, and the validated dynamic dispatch cast in `pi-tool-bridge.ts` when its invariant still holds. General-purpose schema validation is not a substitute for CodeMode's hostile-value inspection.

### Small owned-data fixes

- `packages/pi-git-checkpoints/src/git-checkpoint-store.ts:352–358`: make `writeJsonAtomically` accept its actual owned metadata contract rather than a throwaway `<Value extends object>` parameter. Preserve write/rename behavior.
- `packages/pi-web-tools/src/web-search.ts:134–137,233–273`: type the known provider request body instead of widening it into `object`. Keep provider payloads, credentials, optional fields, and serialization unchanged.

**Verify:** run `check_package` for `pi-lsp`, `pi-dap`, `pi-codemode`, `pi-minimal-subagents`, `pi-git-checkpoints`, and `pi-web-tools`, plus ordinary lint. In CodeMode, specifically retain the real AgentSession capture tests in `test/pi-tool-bridge.test.ts` and hostile-value/mutated-built-in coverage in `test/codemode-session-coordinator.test.ts`. Passing lint alone is insufficient: inspect the resulting contracts for an equivalent spelling of each removed shortcut.

## 4. Make partial test fixtures honest

Replace the implicit-`any` intermediary at these sites:

| File, relative to `packages/`                    | Original lines                |
| ------------------------------------------------ | ----------------------------- |
| `pi-minimal-subagents/test/ui.test.ts`           | 32, 125, 154, 173             |
| `pi-minimal-subagents/test/status-panel.test.ts` | 71, 74, 77, 80, 208, 211, 218 |
| `pi-minimal-subagents/test/extension.test.ts`    | 777, 782, 787                 |
| `pi-dap/test/dap-observer-ui.test.ts`            | 28, 30                        |

Use ordinary inferred fixture objects checked against existing narrow types. Keep the real ExtensionRunner integration harness in the Minimal Subagents extension test. Where a concrete framework type prevents structural assignment, use a local cast documenting exactly which members the tested path exercises and the minimum required next-line exception. A typed partial fixture before that cast preserves checking of the supplied members.

Do not introduce a universal fixture-casting helper or instantiate complete framework sessions merely to silence lint. Small structural type changes are acceptable only when they accurately describe a production consumer's existing dependencies. Preserve intentional null-prototype semantics in guest-runtime tests; those are not the fixture shortcuts above.

**Verify:** `check_package pi-minimal-subagents` and `check_package pi-dap` pass. `rg -n 'Object\.create\(null\)'` on the four listed files returns no fixture shortcuts. Existing UI assertions still exercise the same controller/component paths, and every retained partial-fixture cast states its limitation.

## 5. Build optional fields with conditional assignments

Replace both ternary empty-object spreads and their logical `&&` equivalents with a precisely typed object followed by assignments for present fields. Keep `false`, `0`, and empty-string values when the original condition kept them; do not substitute truthiness for definedness. Preserve property absence rather than assigning `undefined`.

The 29 logical-spread sites are:

| File, relative to `packages/`                    | Original lines                                   |
| ------------------------------------------------ | ------------------------------------------------ |
| `pi-codemode/src/pi-codemode-extension.ts`       | 123, 470, 471, 513, 515, 516, 518                |
| `pi-codemode/src/codemode-tool-catalog.ts`       | 515, 542, 654                                    |
| `pi-codemode/test/codemode-tool-catalog.test.ts` | 29, 30                                           |
| `pi-dap/src/dap-session.ts`                      | 1054, 1055, 1095, 1096, 1108                     |
| `pi-dap/src/dap-tool.ts`                         | 294, 295, 298, 299, 320, 321, 322, 328, 329, 341 |
| `pi-mcp/src/mcp-content.ts`                      | 160, 207                                         |

MCP's suppressed ternary spreads occur in the files listed in step 6. Remove their conditional-spread exemptions as their code is converted. Leave unrelated array spreads and ordinary object spreading alone.

Extend the existing command, catalogue, launch/status, content, and nested-tool tests where they lack coverage of absent versus present optional fields. Use property-presence assertions such as `Object.hasOwn(result, "field")` for absent fields; equality to `undefined` alone does not prove omission.

**Verify:** `check_package pi-codemode`, `check_package pi-dap`, `check_package pi-mcp`, and ordinary lint pass. Search spread expressions in the listed files and inspect multiline cases; all audited conditional-field constructions use assignments without widening the result type.

## 6. Replace file-wide exemptions with justified local exceptions

Remove all 17 leading disable directives across these 11 MCP files. Fix the underlying owned-code issue, or place an exception at the smallest genuine parser, rendering, or fixture boundary. Every remaining exception names the rule, explains why the operation is necessary, and identifies the check/invariant that makes it appropriate. Use `SAFETY:` for assertions as required by the current rule.

Files relative to `packages/pi-mcp/`; rule names omit `anti-slop/no-`:

| File                            | Rules currently exempted across the file                                                                                           |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `src/mcp-presentation.ts`       | conditional-empty-object-spread, known-value-widening, runtime-typeof, unknown-parameters, unknown-returns, unsafe-dictionary-type |
| `src/mcp-settings-store.ts`     | runtime-typeof, unknown-parameters                                                                                                 |
| `src/mcp-command.ts`            | conditional-empty-object-spread, runtime-typeof                                                                                    |
| `src/pi-mcp-cli.ts`             | conditional-empty-object-spread, runtime-typeof, unknown-parameters                                                                |
| `src/mcp-auth-store.ts`         | conditional-empty-object-spread, runtime-typeof, unknown-parameters                                                                |
| `src/mcp-command-completion.ts` | conditional-empty-object-spread                                                                                                    |
| `src/mcp-tool-catalog.ts`       | conditional-empty-object-spread                                                                                                    |
| `src/mcp-oauth.ts`              | conditional-empty-object-spread, runtime-typeof, unknown-parameters                                                                |
| `src/pi-mcp-extension.ts`       | conditional-empty-object-spread, runtime-typeof, unknown-parameters                                                                |
| `test/mcp-presentation.test.ts` | known-value-widening, unsafe-dictionary-type                                                                                       |
| `test/mcp-command.test.ts`      | conditional-empty-object-spread, unknown-parameters                                                                                |

The `pi-mcp-settings.ts:264–302` interpolation exception is already bounded and re-enabled; retain it if still needed. Terminal-control regexes, real process/JSON parsers, synchronous receiver capture, and hostile guest checks have plausible narrow exceptions. Review their actual code before changing them. A lower total comment count is not a reason to broaden an exemption.

Remove these ten currently unused rule entries, retaining any other still-needed rule on the same comment:

| File, relative to `packages/`                                  | Original lines    | Unused rule                       |
| -------------------------------------------------------------- | ----------------- | --------------------------------- |
| `pi-mcp/src/mcp-client-pool.ts`                                | 596               | `no-var`                          |
| `pi-minimal-subagents/src/minimal-subagents-fork-lifecycle.ts` | 5                 | `no-var`                          |
| `pi-codemode/src/codemode-worker.ts`                           | 887               | `anti-slop/no-unknown-parameters` |
| `pi-mcp/src/pi-mcp-cli.ts`                                     | 4                 | `anti-slop/no-unknown-parameters` |
| `pi-context-management/test/context-tools.test.ts`             | 45, 47            | `anti-slop/no-widen-then-assert`  |
| `pi-todo/test/pi-todo-extension.test.ts`                       | 79, 130, 145, 158 | `anti-slop/no-widen-then-assert`  |

The six double-cast sites still need their chained-assertion exemption unless their fixture construction also changes.

**Verify:** `check_package pi-mcp`, `check_package pi-todo`, `check_package pi-context-management`, ordinary lint, and `node_modules/.bin/oxlint --report-unused-disable-directives-severity error` all pass. Repeat `rg -n '(oxlint|eslint)-(disable|enable)' packages`: no file-wide exemptions remain in the 11 files; every region has an explicit re-enable and covers only its stated boundary. No conditional-empty-object-spread exemption remains.

## 7. Final verification and handoff

Run the equivalent of the repository's full verification without package-manager lifecycle side effects:

```bash
set -e
node_modules/.bin/oxfmt --check
node_modules/.bin/oxlint
node_modules/.bin/oxlint --report-unused-disable-directives-severity error
node_modules/.bin/tsc --noEmit

# pi-utils' existing test script requires its build first.
node_modules/.bin/tsc -p packages/pi-utils/tsconfig.build.json
for directory in packages/*; do
  [ -f "$directory/package.json" ] || continue
  check_package "${directory##*/}" || exit 1
done

git diff --check
git status --short
```

All commands must succeed; do not treat skipped or environment-blocked suites as passing. The pi-utils build is verification output, not an implementation change: inspect the final diff and keep generated outputs out of the patch. Do not run release, pack, or install workflows for this code-only cleanup.

Complete a source review that the unchanged lint rules cannot perform:

- Every audited `LSPAny` flow is replaced by a known contract or an honest, validated/opaque boundary; no equivalent imported alias or unchecked generic restores the lost type.
- Empty schemas no longer pretend to validate JSON. Every remaining type assertion or schema type claim is supported by an actual check, producer guarantee, or explicitly limited test fixture.
- The captured `Reflect.apply`, guest classifiers, compatibility adapter, generic serializer, web request bodies, and parser parameter spellings have explicit contracts rather than concealed exceptions.
- All 16 fixture sites and 29 logical-field spreads are accounted for, alongside MCP's suppressed ternary spreads.
- Broad exemptions are gone, necessary local exceptions remain explained, and the stricter unused-directive check is clean.
- Historical replay/settings, optional-property omission, live structured output, guarded Workspace Edit application, and CodeMode's guest isolation retain their tested behavior.
- The diff stays inside the agreed package code/test scope. The lint implementation, its distributed copy, configuration, hooks, CI, and dependency files are unchanged.

Report changed files, checks and their results, and remaining justified exceptions grouped by purpose. Machinery weaknesses and its 39 excluded tracked JS/TS files remain deliberately outside this work; do not claim they were fixed. Update this plan's status only after implementation and verification are actually complete.

## Implementation report

Changed 54 source/test files within the agreed scope:

| Package                          | Source files | Test files |
| -------------------------------- | -----------: | ---------: |
| `packages/pi-codemode`           |            4 |          3 |
| `packages/pi-context-management` |            0 |          1 |
| `packages/pi-dap`                |            3 |          4 |
| `packages/pi-git-checkpoints`    |            1 |          0 |
| `packages/pi-lsp`                |            5 |          2 |
| `packages/pi-mcp`                |           11 |          7 |
| `packages/pi-minimal-subagents`  |            6 |          5 |
| `packages/pi-todo`               |            0 |          1 |
| `packages/pi-web-tools`          |            1 |          0 |

The complete verification above passed: **917 tests across 100 files in all 14 packages**, root and package typechecks, ordinary lint, strict unused-directive lint, formatting, and whitespace checks. Independent Standards and Spec reviews reported zero actionable findings each. No lint machinery, dependency, generated declaration, or release files changed.

Remaining justified exceptions, grouped by purpose:

- **Parsing and presentation:** explicit raw `unknown`, field refinement, opaque protocol passthrough, and failure-contained historical rendering. MCP's remaining regions each cover one function and are explicitly re-enabled.
- **Runtime safety:** captured `Reflect.apply`, non-observable guest classification, and the capability-checked private AgentSession compatibility cast.
- **Test fixtures:** checked partial framework objects with local casts identifying the members exercised.
- **Construction:** four DAP mutable drafts retain their exact readonly owner contracts; local exceptions explain the lint heuristic's false positives.

Regression coverage preserves un-serialized Registry events/checkpoints and foreign-root filtering, historical MCP extras, live structured output, optional-property omission, and guest isolation. It also verifies malformed Workspace Edit rejection and prevents primitive MCP settings documents from masquerading as writable objects. All 16 fixture sites, 29 logical spreads, and MCP's suppressed ternary spreads are accounted for.

## Stop and ask

Pause the affected step if its fix would require changing lint machinery or dependencies, narrowing a documented public tool interface, changing supported persisted formats, removing a hostile-value protection, or building a protocol-wide type system. Also pause if callers have changed enough that this plan's boundary assumptions no longer hold. Report the concrete conflict and the smallest choices available instead of replacing the old workaround with a new one.
