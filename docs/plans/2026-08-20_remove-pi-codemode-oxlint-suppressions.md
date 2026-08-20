# Remove Pi CodeMode Oxlint suppressions

**Status:** Complete

## Implementation note

The worker protocol remains dependency-free because the same parser runs inside the permission-denied Deno process. Importing TypeBox there breaks workspace and installed-layout startup. It instead parses JSON once into an owned recursive protocol representation, then performs the existing exact-shape checks.

## Outcome

Replace Pi CodeMode's broad lint suppressions with precise boundary types and
parsers while preserving every public tool, protocol message, notebook
semantic, Pi compatibility check, model-facing result, and TUI rendering.

The completed package has:

- no file-wide `oxlint-disable` directive;
- no suppression around values that an owning parser or upstream contract has
  already made precise;
- only expression-level anti-slop exceptions where satisfying the rule would
  weaken hostile-value handling, private Pi compatibility checks, or another
  tested invariant;
- only the already-approved ordinary exceptions for terminal control removal,
  transformed-source evaluation, primordial capture, and the transient Pi
  receiver capture.

## Decisions

- Scope is `packages/pi-codemode` only.
- Preserve `.oxlintrc.json`, all rule severities, and
  `tools/oxlint/anti-slop/` byte-for-byte.
- Prefer TypeBox for ordinary serialized and historical input. Keep
  hand-written inspection for hostile guest objects where a schema library
  could invoke getters, proxies, prototypes, or guest-mutated globals.
- Keep parsing in the module that owns the boundary. Prefer deleting or
  simplifying code before adding a type or parser, and add no adapter or module
  solely to satisfy lint.
- Preserve behavior. If removing a suppression would weaken validation, change
  output, or require a substantial abstraction, retain one line-local
  `SAFETY:` exception with a focused proof.
- Add no suppression allowlist or suppression-regression checker.
- This cleanup changes no CodeMode domain term or durable architectural
  decision, so it requires no `CONTEXT.md`, ADR, README, or Changeset edit.

## Baseline

Pi CodeMode currently contains **47 suppression directives**:

- 41 mention anti-slop rules;
- 6 mention ordinary Oxlint rules;
- 4 are file-wide disables.

Removing the directives in a disposable copy exposes **106 anti-slop
diagnostics** and **5 ordinary diagnostics** in owned source/tests. One current
ordinary suppression is unused.

| Area                                | Anti-slop diagnostics exposed |
| ----------------------------------- | ----------------------------: |
| Deno worker                         |                            33 |
| Worker protocol                     |                            15 |
| Pi AgentSession capture             |                            19 |
| Tool catalogue                      |                            16 |
| JSON result contract                |                             5 |
| Pi bridge and extension composition |                             6 |
| Transcript and presentation         |                             5 |
| Tests                               |                             7 |
| **Total**                           |                       **106** |

Before source edits, record outside the repository:

1. `git status --short`;
2. JSON Oxlint output with the current directives removed in a disposable
   copy;
3. SHA-256 hashes of `.oxlintrc.json` and `tools/oxlint/anti-slop/**`;
4. the passing package typecheck and test baseline.

## Implementation sequence

### 1. Characterize the protected boundaries

Add or confirm focused tests before refactoring:

- `codemode-worker-protocol.test.ts`: every request/response variant, exact
  fields, invalid JSON, duplicate tool names and IDs, and oversized lines;
- `codemode-tool-contract.test.ts`: primitives, sparse/accessor arrays,
  symbols, functions, cycles, hostile proxies, non-finite numbers, nested
  `undefined` normalization, and byte limits;
- `codemode-worker-smoke.test.ts` and coordinator tests: hostile Cell values,
  thrown proxies, guest-mutated built-ins, nested tool batching, detached
  failures, Session reuse, timeout, and shutdown;
- `pi-tool-bridge.test.ts` and extension tests: malformed text/image content,
  null/array/primitive tool arguments, missing private registry members, every
  callable capability failure, and exact wrapper identity;
- rendering/catalogue tests: malformed historical details, arbitrary JSON
  Schema input, local references, recursion, descriptions, and output bounds.

Map each suppression group to the existing focused tests first. Add examples
only for uncovered behavior. Use `fast-check`, already installed at the root,
only if an identified parser-totality gap is materially stronger than a short
example table.

**Complete when:** each retained validation invariant has an explicit assertion
at the public or closest reliable boundary, without mutation-testing or
test-only production seams.

### 2. Derive the worker protocol from schemas

In `codemode-worker-protocol.ts`:

1. Define strict TypeBox schemas for worker requests, responses, tool calls,
   settlements, and error payloads; derive their TypeScript contracts from the
   schemas rather than maintaining parallel broad dictionaries.
2. Parse each JSON line once into the matching structural representation.
3. Keep semantic checks that schemas do not express clearly—non-empty and
   unique tool names and the 8 MiB byte boundary—on the parsed representation.
   Cross-message Session/Cell/batch correlation remains coordinator behavior
   and stays covered by coordinator tests.
4. Delete the file-wide directive and all protocol suppressions made redundant
   by the parsed representation. Retain a line-local anti-slop exception only
   when its tested safety rationale satisfies the decisions above.

Do not relax `additionalProperties: false`, error messages, protocol version,
or accepted message variants.

**Complete when:** the file has no broad directive or suppression around parsed
values, any added parser property tests pass, and the real Deno process smoke
remains green.

### 3. Give JSON Schema and result JSON owned boundary types

In `codemode-tool-catalog.ts`:

1. Preserve the current acceptance of arbitrary structural JSON Schema,
   including boolean schemas and non-TypeBox documents.
2. Replace `inputSchema: unknown` and `Record<string, unknown>` with a precise
   recursive JSON-Schema representation/parser owned by the catalogue.
3. Reuse TypeBox's schema representation or guard only if a focused tracer
   proves that doing so does not narrow the existing structural contract.
   Otherwise retain one narrow boundary exception when that is clearer than a
   duplicate schema implementation.
4. Preserve deterministic rendering, local `$ref`, recursion/depth fallback,
   arbitrary property names, JSDoc bounds, and the 1 MiB catalogue refusal.

In `codemode-tool-contract.ts`:

1. Keep descriptor-based hostile JSON inspection; do not replace it with
   `JSON.stringify`, coercion, or a schema traversal that invokes guest code.
2. First simplify repeated inspection and carry already-proven values. Introduce
   a named runtime representation or discriminated classifier only where it
   removes repeated uncertainty without obscuring the hostile boundary.
3. Centralize property-key classification so symbol rejection needs at most one
   line-local runtime-type exception.
4. Preserve omission of object `undefined`, array `undefined` to `null`, sparse
   and accessor rejection, cycle detection, finite-number checks, and byte
   accounting.

**Complete when:** the catalogue file-wide directive is gone; result parsing
carries precise values after ingress; any retained hostile-ingress exception is
expression-level, has a `SAFETY:` comment, and names its focused hostile-value
test.

### 4. Collapse the Pi private compatibility checks

In `pi-agent-session-capture.ts`:

1. Delete the redundant public `getAllTools` callable check—the captured
   prototype descriptor has already proved it—and the duplicate `parameters`
   object check.
2. Keep the fail-closed version/capability behavior. Consolidate repeated
   callable, string, object, and optional-member checks where one honest parser
   is clearer than suppressing every `typeof` expression; retain narrow checks
   when consolidation would hide which private capability failed.
3. Continue reading `_toolRegistry` fresh on every nested call and checking
   each wrapper's exact name, label, description, parameters, execute function,
   optional preparation function, and execution mode.
4. Retain the transient `no-this-alias` exception for the approved synchronous
   receiver capture unless an equally direct implementation removes it without
   changing descriptor restoration.

In `pi-tool-bridge.ts` and `pi-codemode-extension.ts`:

1. Parse text/image bridge content with focused TypeBox schemas after the value
   has crossed the hostile JSON parser.
2. Reuse the parsed JSON-object contract for nested tool arguments and reject
   arrays, null, and primitives exactly as today.
3. Remove the five bridge and one extension runtime-type suppressions.

**Complete when:** capability mutation tests still fail closed, exact Pi wrapped
handlers and hooks still execute, and the Pi integration files contain only
reviewed private-seam exceptions plus the approved receiver capture.

### 5. Narrow the Deno worker's guest-value boundary

In `codemode-worker.ts`:

1. Delete the file-wide four-rule directive.
2. Replace broad `unknown` inputs/returns with precise guest error, protocol
   settlement, and notebook-binding contracts where the worker already knows
   the value. At genuinely arbitrary guest ingress, keep uncertainty explicit.
3. Simplify repeated guest-value classification through captured primordials
   where doing so remains clearer. Do not replace descriptor/prototype
   inspection with coercion, `instanceof`, guest methods, uncaptured globals, or
   a lint-only value hierarchy.
4. Preserve non-forgeable error classification, hostile proxy containment,
   JSON limits, fixed-point detached tool draining, and serialized stdout.
5. Retain any required line-local anti-slop exception only when the alternative
   weakens hostile-value handling or adds substantial lint-only machinery. Keep
   the one real primordial `typescript/unbound-method` exception and remove the
   currently unused primordial suppression.

The worker is the highest-risk wave. Run its focused protocol, smoke,
coordinator, timeout, cancellation, and installed-layout tests before touching
presentation code.

**Complete when:** no broad directive or suppression around already-classified
values remains, all hostile-value tests pass, and workspace/tarball/Git worker
smoke tests still execute native TypeScript.

### 6. Parse Transcript input and type test harnesses

In `codemode-tool-rendering.ts`, `codemode-presentation-output.ts`, and
`codemode-observer-ui.ts`:

1. Change `renderCodeModeToolCall`'s `parameters: unknown` input to the owned
   recursive JSON-value representation that persisted historical arguments can
   actually contain. Keep the existing per-tool public-schema checks and
   malformed-history fallback, then carry the resulting discriminated parameter
   type through the renderer.
2. Add or reuse one schema-backed `CodeModeJsonObject` parser for presentation
   values instead of local runtime-type branches.
3. Preserve deterministic ordering, semantic summaries, bounds, malformed
   historical fallback, terminal sanitization, and width behavior.
4. Retain the two expression-level `eslint/no-control-regex` exceptions for
   explicit C0/C1 removal.

In `codemode-cell-transform.test.ts`, `codemode-tool-catalog.test.ts`, and
`pi-codemode-extension.test.ts`:

1. Type fixtures from their production owner contracts.
2. Replace the file-wide test directive with precise fixture types and Proxy
   property-key handling. Keep a narrow hostile-fixture exception when a broad
   value type would only hide the test's actual boundary.
3. Retain only the expression-level `typescript/no-implied-eval` exception
   where executing transformed source is the behavior under test.

**Complete when:** presentation and test files contain no anti-slop unknown,
return, dictionary, or ordinary parsed-value suppressions and all rendering
snapshots remain unchanged.

### 7. Audit the remaining exceptions

Run Oxlint with unused-directive reporting:

```bash
pnpm exec oxlint --report-unused-disable-directives packages/pi-codemode
```

Inspect every remaining directive manually. The accepted shape is:

- no file-wide directive;
- anti-slop exceptions only where the reviewed alternative weakens a tested
  hostile/private boundary or adds substantial lint-only machinery;
- every anti-slop exception is expression-level, begins with `SAFETY:`, names
  the unsafe alternative, and points to a focused test;
- ordinary exceptions only for two terminal-control regexes, transformed-source
  evaluation, one required primordial capture, and the transient Pi receiver
  capture.

Delete any unused directive. Do not add the rejected suppression allowlist or a
new verification script.

**Complete when:** each remaining exception proves a correctness or interop
invariant that TypeScript and the configured rules cannot express; the final
review can account for every directive individually.

### 8. Run the proof gate

Run focused checks after each wave, then:

```bash
pnpm --filter @ian-pascoe/pi-codemode typecheck
pnpm --filter @ian-pascoe/pi-codemode test
pnpm exec oxlint --report-unused-disable-directives packages/pi-codemode
pnpm verify
git diff --check
```

Compare the lint configuration and plugin hashes with the baseline. Review the
diff along two axes:

- **Standards:** parsing ownership, precise types, safety comments, test seams,
  and absence of lint-policy weakening;
- **Spec:** exact public schemas/results, notebook behavior, Pi handler identity,
  exposure, Deno isolation, protocol bounds, Transcript output, and Observer
  lifecycle.

**Complete when:** all checks pass; hashes match; Oxlint reports zero
diagnostics; no file-wide directive remains; the final report inventories every
retained line-local directive with its rationale and focused test; and no
caller-visible behavior changed.

## Pause

Do not implement until this plan is approved.
