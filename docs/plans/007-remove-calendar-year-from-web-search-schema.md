# Plan 007: Keep the Web Search tool description independent of calendar year

> Execute from the repository root and update this plan's row in `docs/plans/README.md` only after verification. Do not implement other cache findings in this change.
>
> Drift check: `git diff --stat 127e85a..HEAD -- packages/pi-web-tools/src/web-search.ts packages/pi-web-tools/test/pi-web-tools-extension.test.ts`. Reconcile any differences against the excerpt below before proceeding.

## Status

- Priority: P3
- Effort: S
- Risk: LOW
- Depends on: none
- Category: perf
- Planned at: `127e85a`, 2026-09-09
- Execution status: TODO

## Why this matters

Web Search inserts a year into its tool description when the module loads. A module loaded across a year boundary has a different definition for the same capability, which can invalidate a cached tool prefix. This is minor hygiene, not a recurring per-turn problem: the expression does not reevaluate on each request and ordinary cache lifetimes make the practical impact small. Remove the date claim instead of adding a date-injection subsystem.

## Current state

`packages/pi-web-tools/src/web-search.ts:117`:

```ts
const WEB_SEARCH_DESCRIPTION = `Discover current public web information using Exa or Parallel. Results are textual and model-visible output is truncated to 50 KiB or 2,000 lines, with complete output saved to a private temporary file. The current year is ${new Date().getFullYear()}.`;
```

`packages/pi-web-tools/test/pi-web-tools-extension.test.ts:61` currently requires the year:

```ts
expect(search?.description).toContain(String(new Date().getFullYear()));
```

`src/index.ts:23–37` creates tools once and registers Web Search followed by Web Fetch. `test/pi-web-tools-extension.test.ts` uses `createWebToolsTestRunner` from `test/web-tools-test-harness.ts` to inspect real registrations. Preserve that order and the existing truncation contract.

Vocabulary from `packages/pi-web-tools/CONTEXT.md`: **Web Search** is a query to a remote **Search Provider**; **Web Fetch** retrieves one URL without executing page JavaScript. The calendar year is not part of either operation's input schema or transport contract. Follow source-TypeScript conventions and use the existing Vitest installation; add no dependency.

## Scope

Only modify:

- `packages/pi-web-tools/src/web-search.ts`
- `packages/pi-web-tools/test/pi-web-tools-extension.test.ts`
- This plan and its status row in `docs/plans/README.md`

Out of scope: search query rewriting, freshness filters, new date tools, system/context hooks, API credentials, network transports, Web Fetch, schemas, package versions, and lockfile. Do not move the year into another dynamic tool-description field.

## Commands

Run from the repository root:

```sh
./node_modules/.bin/vitest run --config "$PWD/vitest.config.ts" --root packages/pi-web-tools test/pi-web-tools-extension.test.ts
./node_modules/.bin/vitest run --config "$PWD/vitest.config.ts" --root packages/pi-web-tools
./node_modules/.bin/tsc --noEmit -p packages/pi-web-tools/tsconfig.json
./node_modules/.bin/oxlint packages/pi-web-tools/src/web-search.ts packages/pi-web-tools/test/pi-web-tools-extension.test.ts
./node_modules/.bin/oxfmt --check packages/pi-web-tools/src/web-search.ts packages/pi-web-tools/test/pi-web-tools-extension.test.ts
```

Expected completion: all exit 0. Use installed binaries rather than `pnpm exec`, which triggered automatic preparation/reference synchronization during the audit. If dependencies are absent, ask the operator before installing anything.

## Steps

### 1. Add a cross-module-load regression

Extend `test/pi-web-tools-extension.test.ts` using its registration harness. Independently load the extension with Vitest module isolation/reset under two mocked dates in different years; compare the registered model-facing `name`, `description`, `parameters`, `promptSnippet`, and `promptGuidelines` for both tools. Obtain both registrations through fresh dynamic imports, not the existing static import: changing the clock after module evaluation would miss this bug. Restore clock and module state in `finally` so other tests remain unaffected. Do not compare renderer or execute function identity.

**Verify:** The focused test command fails on differing Web Search descriptions on the current code. Existing registration order and truncation assertions remain unchanged. No network requests are made by this regression.

### 2. Remove only the calendar sentence

Replace the template literal with the same timeless description ending at `private temporary file.` Remove the old year-presence assertion; keep existing contract assertions. Do not add a new date instruction elsewhere.

**Verify:** Run all five commands above; all pass. Run `rg -n 'getFullYear|The current year is' packages/pi-web-tools/src/web-search.ts`; expected no matches (exit 1). `git diff --check` exits 0.

## Done criteria

- [ ] Independent module loads across calendar years register identical model-facing definitions.
- [ ] Existing registration order, truncation wording, schema-validation and execution tests pass.
- [ ] No new system prompt, context message, date tool, setting or dependency was introduced.
- [ ] All completion gates pass and the tracked diff is limited to scope.
- [ ] Index row records completion and commands run.

## Git workflow and STOP conditions

Use the operator's branch and preserve unrelated changes. Do not commit, push, publish or open a PR without authorization. If authorized later, use the repository's conventional style, e.g. `fix(pi-web-tools): keep search description date-independent`.

Stop if an external documented contract requires the literal year, if the module-reset test cannot exercise a fresh evaluation without invasive harness changes, or if a gate fails twice after reasonable fixes. Report the blocker rather than claiming a test that merely changes the clock validates module-load behavior.

## Maintenance notes

Changing returned search content is legitimate new result data. This plan only stabilizes tool metadata. Real current-date context, if later requested, deserves its own explicit requirement; do not create it speculatively here.
