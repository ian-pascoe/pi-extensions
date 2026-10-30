# Research: Bun as package manager and `tsrs` in place of `typescript`

Status: research only. No repository files were changed; no installs were run in the repo. Source checks used read-only commands, `npm view`, GitHub/npm/Bun/Turborepo/Vitest web sources, and a read-only copy of the `oxc-project/tsrs` main-branch tarball downloaded to `/tmp/tsrs-src/` (outside the repo). Observations are dated 2026-10-30 (the date of the npm and GitHub data retrieved).

Labels used below: **[verified]** checked in a primary source or local file; **[inferred]** follows from checked sources but was not run; **[unverified]** needs a test in a scratch clone.

---

## Summary

1. **tsrs** is one project, `oxc-project/tsrs` (npm `tsrs`, latest `0.20.1-ts7.1.0-beta`, Apache-2.0). It is a Rust port of the TypeScript 7 native compiler (tsgo) that pins **TypeScript 7.1.0-beta**, not the **7.0.2** this repo uses. It is a beta, its repo is about a month old, and its own docs say a stable release is only planned against 7.1. Its CLI is `tsrs`, not `tsc`, so every `tsc` call in the repo must change. It supports `--noEmit`, `--build` (project references), JS and `.d.ts` emit, and `--lsp -stdio`. It does not support `--init` or `--showConfig`.
2. **Removing `typescript` breaks** 17 package `typecheck` scripts, the root `typecheck:root`, `packages/pi-utils` `build` (`tsc -p tsconfig.build.json`, run from `prepack`), the `pi-lsp` integration test (spawns `node_modules/.bin/tsc --lsp --stdio`), and the `pi-lsp` LSP server config in `.pi/settings.json` plus its README example. Nothing else in the lockfile depends on `typescript`. `oxlint-tsgolint` is a standalone Go binary and does not need the npm package. `vitest`, `@changesets/cli`, `lint-staged`, `husky`, `oxfmt`, and Pi itself have no dependency on it.
3. **Bun as package manager** is feasible, with these changes: add `tools/*` to the root `workspaces` (the root `package.json` lists only `packages/*`); convert `pnpm-workspace.yaml` `allowBuilds` to `trustedDependencies`, `minimumReleaseAgeExclude` to `minimumReleaseAgeExcludes`, and set `install.peer = false` to replace `legacy-peer-deps`. `workspace:` and `catalog:` are supported but unused here. Changesets publishes through `npm` for any non-pnpm/yarn repo, so `npm publish` (and provenance) keeps working. `bun publish` rejects provenance, so do not use it. `bun pm pack` has no documented `--json` flag, so `scripts/check-package-packs.mjs` must change. Turborepo supports the text `bun.lock`.
4. **Vitest 5 should stay.** `bun run test` runs the `vitest` bin with Node by default (Bun honors the `#!/usr/bin/env node` shebang). `bun test` is a different runner and would need rewriting many tests (e.g. `vi.waitFor` ×102, `vi.stubEnv` ×17, `onTestFinished` ×93). Keeping Vitest also keeps `process.execPath` as Node in tests that spawn child processes.
5. **Node stays required** (Pi and `engines.node >=22.19.0`; Vitest 5 needs Node ≥22.12). Bun would be an additional toolchain, not a replacement runtime.
6. **GitHub Actions:** `oven-sh/setup-bun@v2` (latest tag `v2.2.0`, 2026-03-14). It caches only the Bun executable (`no-cache` input). Cache `~/.bun/install/cache` separately with `actions/cache`, keyed on `bun.lock`. Node setup is still needed.

**Recommendation (inferred from the above):** Do the Bun migration on its own (it is well supported). Treat tsrs as an experiment: keep `typescript@7.0.2` as the gate until tsrs has a stable release on the same TypeScript version, and first compare its diagnostics against `tsc` 7.0.2 over this repo.

---

## 1. What "tsrs" is

### Candidates

| #   | Name                                                                                                                   | Source                                                                   | Status                                                                                                                                                                                         |
| --- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A   | `oxc-project/tsrs` → npm `tsrs` (+ `@tsrs/<platform>` binaries)                                                        | https://github.com/oxc-project/tsrs ; https://www.npmjs.com/package/tsrs | **The project.** Active, Apache-2.0, beta.                                                                                                                                                     |
| B   | GitHub `maschwenk/tsrs`                                                                                                | https://github.com/maschwenk/tsrs                                        | Same project under its earlier owner. The GitHub API for `maschwenk/tsrs` returns `oxc-project/tsrs` (repo moved/renamed).                                                                     |
| C   | npm `@maschwenk/tsrs` (latest `0.11.0-ts7.1.0-dev.20260929`, published 2026-10-10, maintainer `maschwenk`, Apache-2.0) | https://www.npmjs.com/package/@maschwenk/tsrs                            | Earlier, scoped publication by the original author. Not recommended; not evaluated further.                                                                                                    |
| D   | npm `tsrs` `0.0.0`…`0.0.0-snapshot-*` (2024, MIT, napi-rs, maintainer `qidanta`)                                       | `npm view tsrs`                                                          | Unrelated older package. The README acknowledges that `JiangWeixian` transferred the npm name. The npm `snapshot` dist-tag still points at this 2024 build. **Do not use the `snapshot` tag.** |
| E   | crates.io `tsrs`                                                                                                       | https://crates.io/api/v1/crates/tsrs                                     | HTTP 404 (no crate).                                                                                                                                                                           |

**[verified]** Candidate A is the only current candidate. Use `tsrs@latest` (`0.20.1-ts7.1.0-beta`).

### Key facts (candidate A)

- **Repo:** https://github.com/oxc-project/tsrs. Created 2026-10-01, default branch `main`, Apache-2.0, ~2,600 stars, last push 2026-10-30 (GitHub API).
- **Description:** "Rust port of the TypeScript 7 type checker." The npm package describes itself as "A Rust port of the TypeScript 7 compiler (tsc), language server, and JavaScript API."
- **npm package:** `tsrs`. Latest tag `latest` = `0.20.1-ts7.1.0-beta` (published 2026-10-28). The version string encodes the TypeScript version it ports. Its `tsrs` metadata: `typescriptVersion: "7.1.0-beta"`, `typescriptCommit: 3e9236361fa97a9e6c685f4833ac457ae2d8c50a`. Maintainer on npm: `boshen`. Published from GitHub Actions with provenance attestations. 13+ published versions (0.12.0 through 0.20.1, plus 2024 placeholders).
- **Dependencies:** none. Only seven `optionalDependencies` for platform binaries: `@tsrs/darwin-x64`, `@tsrs/darwin-arm64`, `@tsrs/linux-x64-gnu`, `@tsrs/linux-x64-musl`, `@tsrs/linux-arm64-gnu`, `@tsrs/linux-arm64-musl`, `@tsrs/win32-x64`. **No `win32-arm64` package.** `engines.node >=16.20.0`. Nothing depends on the `typescript` npm package.
- **Bin:** `tsrs` only (`"bin": {"tsrs": "./bin/tsrs"}`). There is **no `tsc` bin**. (`npm view tsrs`; `npm/tsrs/package.json` in the repo tarball.)
- **License:** Apache-2.0. The README says it is "a derivative of TypeScript (Copyright Microsoft Corporation)", the bundled `lib.*.d.ts` are TypeScript's, and it is "Not affiliated with or endorsed by Microsoft."
- **Sponsors/incubation:** Cloudflare and VoidZero are collaborating; the project is incubated in the Oxc toolchain. Source: https://blog.cloudflare.com/typescript-rust-port/ . The blog's benchmark claim (up to 8× faster and ~70% less memory than TS 7.0 at the same worker count) is a vendor claim, **[unverified]** here.

### Maturity

- **[verified]** Version line `0.x` with `-ts7.1.0-beta` suffix; the docs describe `0.20.0` as "beta" and `0.20.1` as the current release. Release history in `docs/STATUS.md` runs from 2026-09-30 to 2026-10-28, i.e. about four weeks of releases.
- **[verified]** README: "drop-in replacement for the TypeScript 7 compiler and language server… Our goal is 100% conformance." COMPATIBILITY: "We aim to release a stable version against TypeScript 7.1 with 100% conformance."
- **[verified]** README "Contributing": issues are open; **pull requests are closed** ("we don't have the bandwidth to review them").
- **[verified]** Conformance evidence (COMPATIBILITY.md): all 13,700 error baselines and 12,998 `.types`/`.symbols` baselines match the pinned reference "with the upstream emit sequence"; a top-1000-repos comparison workflow exists; known gaps are listed (below).

### CLI and flags

Source: `docs/USAGE.md` (https://raw.githubusercontent.com/oxc-project/tsrs/main/docs/USAGE.md), `docs/DEFAULTS.md`.

```sh
tsrs -p tsconfig.json --noEmit     # typecheck only
tsrs -p tsconfig.json              # compile (JS + .d.ts per tsconfig)
tsrs -b [project]                  # --build (project references)
tsrs --watch -p .  |  tsrs -b --watch
tsrs --lsp -stdio                  # language server (only stdio supported)
tsrs --api                         # Node API server
tsrs -p . --extendedDiagnostics    # counters and timings
tsrs --version
tsrs -p . --fast                   # opt-in performance preset (or TSRS_FAST=1)
tsrs -p . --checkers N --singleThreaded --maxMemory 12G   # tsrs-only tuning
```

- Default checker count is 4 (same as tsgo). `--fast` adapts it. The docs say "Default mode preserves TypeScript's sensitivity to checker count and file order" (diagnostics can depend on checker count).
- **Not supported:** `--init` and `--showConfig` (exit status 5). `--generateTrace` warns and runs without tracing. `--locale` is accepted but messages stay English. `--pprofDir` is parsed and ignored. `-b` rejects tsrs-only flags with TS5072.
- **Watch:** Linux (inotify) and macOS (FSEvents/kqueue). Not on Windows (`--watch` exits with "not supported").

### tsconfig compatibility (against this repo's root `tsconfig.json`)

Repo options: `module: NodeNext`, `moduleResolution: NodeNext`, `verbatimModuleSyntax`, `isolatedModules`, `noUncheckedSideEffectImports`, `moduleDetection: force`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `skipLibCheck`, `types: ["@types/node"]`, `allowJs`, `jsx: preserve`, `noEmit`, and per-package `extends` plus `rootDir: "."`.

- **`--build` / project references:** COMPATIBILITY: "`--build` (project references) | yes".
- **Declarations and emit:** "JavaScript emit | yes", "Declaration emit (`.d.ts`) | yes", "Source maps, declaration maps | yes", "Incremental builds (`.tsbuildinfo`) | yes", "Multi-package emit | yes".
- **`moduleResolution: NodeNext` / `nodenext`:** referenced across the source (≈40 files) and in conformance notes ("NodeNext directory-import TS2834 match source 31"). **[verified]** in source; not individually re-run here.
- **`moduleResolution: bundler`:** appears in testdata tsconfigs and tests (`testdata/regressions/*/tsconfig.json`); the docs do not state it explicitly. **[unverified]** as a feature claim.
- **`allowImportingTsExtensions`:** parsed in `crates/tsrs_tsoptions/src/parsinghelpers.rs` and consumed in `crates/tsrs_compiler/src/program.rs` and `crates/tsrs_checker/src/checker_08.rs` (repo tarball `main`). The docs do not call it out. **[inferred]** supported; **[unverified]** behavior.
- **`verbatimModuleSyntax`:** explicit conformance cases (e.g. `verbatimModuleSyntaxDefaultImportTypeOnlyNamed` in COMPATIBILITY.md) and ≈23 source/test references. **[inferred]** supported.
- Options TypeScript 7 removed (ES5 target, AMD/UMD/System, `baseUrl`) are rejected, as in tsgo.

Because this repo's `tsconfig` uses `NodeNext`, `verbatimModuleSyntax`, and `allowImportingTsExtensions`-style source imports, the decisive check is a diagnostic diff (see "Verification plan").

### Language server

- `tsrs --lsp -stdio` (Go-style single dash accepted). Editor setup in https://raw.githubusercontent.com/oxc-project/tsrs/main/docs/LSP.md (VS Code via `js/ts.tsdk.path` → `node_modules/tsrs/tsdk`; Neovim `vim.lsp.config`).
- **Known LSP gaps** (LSP.md and DEFAULTS.md): automatic type acquisition not ported; content mappers (`.vue`/`.svelte`/`.astro`) not loaded by the language server; telemetry limited to request failures; localized messages not ported; Windows watcher backend not ported; several Node API parity gaps.
- **pi-lsp impact:** `pi-lsp` integration test asserts `client.serverInfo?.name === "typescript-go"` (`packages/pi-lsp/test/lsp-server-client.integration.test.ts:162`). The tsrs source (GitHub tarball, `main`) has no `typescript-go` server-name literal, so **expect that assertion to change** [inferred; verify by running it].

### Known gaps vs TypeScript 7 (tsgo) — summary

From `docs/DEFAULTS.md`, `docs/COMPATIBILITY.md`, `docs/LSP.md`:

1. **Different TypeScript version.** tsrs 0.20.1 targets `7.1.0-beta` at commit `3e92363`. This repo uses `typescript@7.0.2` (npm `latest`); `typescript@beta` is `7.1.0-beta`. Switching is a checker upgrade as well as a compiler swap. Diagnostics may differ between 7.0.2 and 7.1-beta in both directions.
2. **Unsupported commands/options:** `--init`, `--showConfig`; `--locale` validation/translation; `--generateTrace`; `--pprofDir`; Windows watch.
3. **History-dependent diagnostics** (checker count, file order) are inherited from TypeScript; default mode mirrors tsgo, `--fast` changes it.
4. **Node API:** `--api` "yes, with gaps"; API build orchestration forced to single-threaded.
5. **Platform:** no `win32-arm64` package; VS Code SDK project-local path "macOS, Linux and Windows x64".
6. **Lint:** tsrs ships a `tsrs-lint` Rust binary claiming 61/61 pinned tsgolint rules. It is **not** the binary `oxlint --type-aware` calls; `oxlint` still uses `oxlint-tsgolint` (Go, `7.0.2005`). See §2.

---

## 2. What depends on the `typescript` package

### Direct `typescript` consumers (must change if removed)

| Location                                                                                          | Use                                                                                                                                                                                                                                                             | Replacement with tsrs                                                 |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `package.json` `devDependencies.typescript` (`^7.0.2`)                                            | provides `tsc` bin (`node_modules/typescript/bin/tsc`, verified)                                                                                                                                                                                                | Add `tsrs`; the bin is `tsrs`, not `tsc`                              |
| root `package.json` `typecheck:root` = `tsc --noEmit`                                             | root `tsconfig.json` (scripts/test/vitest.config)                                                                                                                                                                                                               | `tsrs --noEmit -p tsconfig.json`                                      |
| 17 packages `typecheck` = `tsc --noEmit -p tsconfig.json`                                         | `packages/{pi-advisor,pi-bible-verses,pi-command-deck,pi-context-management,pi-dap,pi-formatter,pi-git-checkpoints,pi-guardian,pi-lsp,pi-minimal-subagents,pi-secret,pi-skills-selector,pi-termctrl,pi-todo,pi-tps-tracker,pi-utils,pi-web-tools}/package.json` | same                                                                  |
| `packages/pi-utils/package.json` `build` = `tsc -p tsconfig.build.json`; `prepack` = `pnpm build` | ships `dist/*.js` and `.d.ts` in the published tarball                                                                                                                                                                                                          | tsrs emits JS and `.d.ts` (verified), but build config must be tested |
| `packages/pi-lsp/test/lsp-server-client.integration.test.ts:~38`                                  | `command: resolve(repositoryRoot, "node_modules/.bin/tsc")`, args `["--lsp","--stdio"]`, asserts `serverInfo.name === "typescript-go"`                                                                                                                          | `tsrs` bin with `["--lsp","-stdio"]`; update name assertion           |
| `.pi/settings.json` `lsp.servers.typescript`                                                      | `pnpm --workspace-root exec tsc --lsp --stdio` (Pi LSP config for this repo)                                                                                                                                                                                    | `tsrs --lsp -stdio` (command form must change)                        |
| `packages/pi-lsp/README.md` example (~line 39)                                                    | `pnpm exec tsc --lsp --stdio`                                                                                                                                                                                                                                   | update doc                                                            |

Also: no source file in `packages/`, `tools/`, `test/` imports the `typescript` module (`grep` found only string literals such as `languageId: "typescript"`).

### Packages that do **not** depend on `typescript`

- **Lockfile:** `pnpm-lock.yaml` has exactly one `typescript@7.0.2` snapshot and its `@typescript/typescript-<platform>@7.0.2` optional natives. No other package declares `typescript` as a dependency or peer (grep of the lockfile). Removing it does not change any other resolution.
- **`oxlint-tsgolint@7.0.2005`:** a Go binary distributed via `@oxlint-tsgolint/<platform>` optional packages; its `package.json` has no `typescript` dependency or peer; its README says it runs on typescript-go and has `--type-check` built in. **[inferred]** type-aware lint keeps working without the npm `typescript` package. (`.oxlintrc.json` sets `options.typeAware` and `options.typeCheck`.) **[unverified]** run `oxlint` after removal.
- **`oxlint` 1.90.0:** `peerDependencies` on `oxlint-tsgolint` (optional) and `vite-plus` (optional). No `typescript`.
- **`vitest` 5.0.5:** peers are `@types/node`, `vite`, optional browser/coverage/jsdom packages. No `typescript`. `vitest.config.ts` has no `typecheck` option (so no vitest typecheck mode).
- **`@changesets/cli` 3.0.3:** dependencies are `@clack/prompts`, `@manypkg/get-packages`, `package-manager-detector`, and similar. No `typescript`.
- **`lint-staged` 17.6.0, `husky` 9, `oxfmt` 0.75.0, `typebox` 1.4.3, `fast-check` 4.10.2, `turbo` 2.11.10:** no `typescript` dependency or peer. (`fast-check` has `typescript ~6.0.3` in its own devDependencies only; not installed.)
- **`@earendil-works/pi-coding-agent` 1.4.0 / `pi-tui` 1.4.0:** no `typescript` dependency (`pi-tui` only lists "typescript" as a keyword). Pi loads extension TypeScript through its own loader (`jiti` 2.7.0 is a Pi dependency; `node_modules/@earendil-works/pi-coding-agent/package.json`), so it does not need the npm `typescript` package.
- **Editor tooling:** no `.vscode/` directory is committed; VS Code uses its own bundled TypeScript unless the user configures `js/ts.tsdk.path`.
- **Husky / lint-staged:** call only `pnpm lint:staged` and `pnpm verify:push` (package-manager commands, not `tsc`).

**Net:** removing `typescript` breaks the explicit `tsc` invocations listed above, and nothing else silently.

---

## 3. Bun as package manager

### Workspaces (`packages/*`, `tools/*`)

- **[verified]** Bun supports `"workspaces"` in `package.json`, glob patterns (including negated), and `--filter`. Source: https://bun.com/docs/pm/workspaces
- **[verified]** Current repo: root `package.json` has `"workspaces": ["packages/*"]`, while `pnpm-workspace.yaml` lists `packages/*` **and** `tools/*`. For Bun, add `"tools/*"` to the root `workspaces` array. `tools/pi-dap-vscode-js-debug/package.json` has a `name`, so Bun will not skip it (Bun skips matched `package.json` files without a `name`).
- **[verified]** Bun's `bun run --filter <pattern> <script>` replaces `pnpm --filter <pkg> <script>` used throughout README/AGENTS (https://bun.com/docs/runtime). Note: `bun --filter … publish` means something else (per the publish docs).
- **[verified]** Bun installs `peerDependencies` by default (https://bun.com/docs/pm/cli/install). This repo sets `legacy-peer-deps=true` in `.npmrc` because "Pi provides extension peer dependencies through loader aliases." Bun does not document `legacy-peer-deps`. **Map it to `[install] peer = false` in `bunfig.toml`** (documented default `peer = true`, same page), then test.
- **[verified]** Lockfile: `bun install` migrates `pnpm-lock.yaml` automatically when no `bun.lock` exists (https://bun.com/docs/pm/lockfile). Text `bun.lock` is default since Bun 1.2.

### `workspace:` protocol

- **[verified]** Supported (https://bun.com/docs/pm/workspaces; rewritten on publish). **Not used** in this repo (`grep "workspace:"` finds none in package.json files). `pnpm pack` and Bun both rewrite it on publish if it appears later.

### Catalogs

- **[verified]** Bun supports `catalog`/`catalogs` in the root `package.json` `workspaces` object or top-level (https://bun.com/docs/pm/catalogs). Bun docs do not describe reading pnpm's `pnpm-workspace.yaml` catalogs. **Not used** in this repo; N/A.

### `allowBuilds` → `trustedDependencies`

- **[verified]** Bun runs lifecycle scripts only for packages on an allow list. Defining `trustedDependencies` **replaces** the built-in default list; `[]` disables all; the lockfile records the list (https://bun.com/docs/pm/lifecycle).
- Current `pnpm-workspace.yaml` `allowBuilds`: `@google/genai: true`, `esbuild: true`, `protobufjs: true`, `tesseract.js: true`, `tree-sitter-bash: false`, `zeromq: false`. For Bun, set `trustedDependencies` to the `true` entries. The `false` entries are not in `pnpm-lock.yaml` and need no mapping. Per Bun docs, if you define an explicit list you must include default-listed packages you still need (esbuild is cited as an example).

### `minimumReleaseAgeExclude` → `minimumReleaseAgeExcludes`

- **[verified]** Bun: `[install] minimumReleaseAge = <seconds>` and `minimumReleaseAgeExcludes = ["name", "name@1.2.3 || 1.2.4"]`; CLI `--minimum-release-age` / `--minimum-release-age-excludes` (https://bun.com/docs/runtime/bunfig; https://bun.com/docs/pm/cli/install#minimum-release-age).
- Repo list is exact-version entries for `@earendil-works/*@1.1.0` (pnpm `minimumReleaseAgeExclude`). Bun accepts `name@version` entries. **Note:** `pnpm-workspace.yaml` sets `minimumReleaseAgeExclude` but not a `minimumReleaseAge`; check pnpm's effective default before porting, and set `minimumReleaseAge` explicitly in `bunfig.toml`.

### `bun pm pack` and publishing

- **[verified]** `bun pm pack` creates a `.tgz` following `npm pack` rules; runs pre/postpack and prepare unless `--ignore-scripts`; options: `--dry-run`, `--destination`, `--filename`, `--ignore-scripts`, `--gzip-level`, `--quiet` (https://bun.com/docs/pm/cli/pm). **No documented `--json`.** The repo's `scripts/check-package-packs.mjs` runs `pnpm pack --json` and parses `{name, filename, files}`; it must be rewritten (for example to `npm pack --json`, which mirrors what consumers and changesets publish).
- **[verified]** `bun publish` "strips catalog and workspace protocols," honors `publishConfig.registry`/`access`/`tag`, and **errors** on `--provenance`, `"provenance": true` in `publishConfig`, and `NPM_CONFIG_PROVENANCE=true` (https://bun.com/docs/pm/cli/publish). This repo sets `publishConfig.provenance: true` in every package and `NPM_CONFIG_PROVENANCE: "true"` in `release.yml`. **So do not switch publishing to `bun publish`.**
- **[unverified]** `publishConfig` _field overrides_ (`main`, `types`, `exports` → `dist/`) used by `pi-utils` and the `pack:check` script. Bun's docs do not describe them for `bun pm pack`. Test the tarball file list and `package.json` before relying on it.

### Changesets under Bun

- **[verified]** `package.json` `version-packages` = `changeset version && pnpm install --lockfile-only`. Bun equivalent: `bun install --lockfile-only` (https://bun.com/docs/pm/lockfile — "use the `--lockfile-only` flag"). `bun add`/`remove`/`update` accept it too.
- **[verified in local source]** `@changesets/cli` 3.0.3 `dist/getPublishPlan.mjs` `getPublishTool()`: for a tool type not in `npm|pnpm|yarn` (Bun repos are detected as `"bun"` by `@manypkg/tools`, which checks `bun.lock`; see `node_modules/.pnpm/@manypkg+get-packages@3.1.0/.../manypkg-tools.js`), it calls `package-manager-detector`'s `detect()`; for `bun` it falls through to **`npm_exports`**, which runs `npm publish` / `npm view`. So `changeset publish` under Bun uses npm, not `bun publish`.
- **[inferred]** Consequences: provenance keeps working (npm honors `publishConfig` and `NPM_CONFIG_PROVENANCE`); `release.yml`'s `npm install --global npm@">=11.5.1"` step remains needed; `workspace:` ranges are not rewritten by `npm publish` (not an issue today; none are used).
- **[unverified]** Run `changeset version` + `bun install --lockfile-only` in a scratch branch and confirm `bun.lock` updates with bumped internal ranges; `changesets/action@v2.1.1` (`version-script`/`publish-script`) should then work unchanged with the new scripts.

### Turborepo with Bun

- **[verified]** Turborepo's install docs list `bunx create-turbo@latest`; the managing-dependencies guide uses `bun install … --dev` (https://turborepo.dev/docs/getting-started/installation ; https://turborepo.dev/docs/crafting-your-repository/managing-dependencies).
- **[verified]** `turbo prune` handles Bun repositories ("references to excluded workspaces are also removed from the pruned manifests and lockfile so the output can be installed with a frozen lockfile") (https://turborepo.dev/docs/reference/prune).
- **[verified in source]** Turborepo's `crates/turborepo-repository/src/package_manager/bun.rs` detects `bun.lock` as `PackageManager::Bun` and returns an error for the binary `bun.lockb` (https://github.com/vercel/turborepo/blob/main/crates/turborepo-repository/src/package_manager/bun.rs). The text lockfile is therefore supported.
- **Repo changes needed:** `turbo.json` `//#test:root` inputs list `pnpm-lock.yaml` (→ `bun.lock`); the `globalDependencies` list has no lockfile. `package.json` `devEngines.packageManager` (pnpm ^12) and `mise.toml` (`pnpm = "12.9.1"`) must change.
- **[unverified]** Confirm `turbo run` invokes Bun correctly for each task in this repo (cache keys include `bun.lock`).

### Frozen installs, scripts and env

- **[verified]** `bun install --frozen-lockfile` and `bun ci` exist; `--frozen-lockfile` does not write a lockfile; `bun install --frozen-lockfile --dry-run` validates without installing (https://bun.com/docs/pm/cli/install).
- **[inferred]** `scripts/prepare.mjs` detects production installs via `npm_config_omit`; Bun's lifecycle env vars (https://bun.com/docs/pm/lifecycle) include `npm_*` names, but whether `npm_config_omit` is set under `bun install --production` is **[unverified]**.
- `.husky/*` and `docs/releases.md` / `README.md` / `AGENTS.md` reference `pnpm` commands and need updating.

---

## 4. Bun test runner vs Vitest

### Does Vitest 5 run under Bun?

- **[verified]** Vitest 5.0 (released 2026-09-03) requires **Vite ≥ 6.4.0 and Node.js ≥ 22.12.0**; running on older versions is unsupported (https://vitest.dev/blog/vitest-5 ; https://vitest.dev/guide/migration ; https://vitest.dev/guide/).
- **[verified]** `bun run <script>` executes package bins with **Node** by default because Bun respects the `#!/usr/bin/env node` shebang; `--bun` forces Bun (https://bun.com/docs/runtime, section "--bun"). The repo's `test` scripts (`vitest run`) therefore run under Node even with Bun as package manager.
- **[verified, reported]** Bun issue #25778 "`bun run` breaks Vitest even when executing with Node" (vitest 2.1.9, Bun 1.3.1): `bun run test` fails with `ReferenceError: Cannot access 'dispose' before initialization`, while direct `node ./node_modules/.bin/vitest run` works. The issue was **closed as duplicate** (2026-01-03); the duplicate target is not shown in the fetched page. **[unverified]** on Vitest 5 + current Bun (1.4.x). Test it before switching.
- **[verified, reported]** Bun issue #40842 (2026-08): `bun test` silently ignores `vitest.config.*` (setupFiles/aliases/plugins), so it can report a false green run. Avoid `bun test` for this repo.
- **Bun 1.4.4** is the current npm `bun` version (`npm view bun version`).

### `bun:test` vs Vitest API usage in this repo

Counts from `grep -rF` over `packages/`, `tools/`, `test/` (`*.ts`):

- Test files: **214** `*.test.ts`. Files importing from `vitest`: **227** (includes helpers). Files using `vi.`: **55**. Zero `bun:test` or `node:test` imports.
- `vi.fn(` 69; `vi.spyOn(` 36; `vi.mocked(` 9; `vi.restoreAllMocks(` 3.
- `vi.useFakeTimers(` 38; `vi.advanceTimersByTime(` 23; `vi.setSystemTime(` 9; `vi.getTimerCount(` 2.
- `vi.waitFor(` **102**.
- `vi.stubEnv(` 17 (14 files) and `vi.unstubAllEnvs(` 14.
- `vi.resetModules(` 4. `vi.mock(` / `vi.doMock(` / `vi.hoisted(` / `vi.importActual(` **0**. The repo's local Oxlint plugin bans module mocking (`anti-slop/no-module-mocking` in `.oxlintrc.json`, implementation in `tools/oxlint/anti-slop/rules/no-module-mocking.ts`), so `vi.mock` is not an obstacle.
- `onTestFinished(` 93 occurrences (23 files).
- `.each(` (`test/describe/it.each`) 176. `toMatchInlineSnapshot(` 2. `toMatchSnapshot(` 0. `expectTypeOf` 1 file (`packages/pi-dap/test/dap-protocol-client.test.ts`).

### Bun equivalents (from Bun docs)

- **Mocks:** `jest.fn`, `spyOn`, and `mock` exist in `bun:test`; `jest.fn()` "behaves identically" to `mock` (https://bun.com/docs/test/mocks). `mock.module()` exists but the repo does not use module mocks.
- **Timers/dates:** `bun:test` supports `setSystemTime`, `jest.useFakeTimers`, `jest.useRealTimers`, `jest.setSystemTime`, `jest.now()`. Bun's docs say that under `bun:test` "Date constructor does not change when you useFakeTimers" (differs from Jest/Vitest). Its `useFakeTimers` signature lists `advanceTimersByTime`, `runAllTimers`, `getTimerCount` (https://bun.com/docs/test/dates-times ; https://bun.com/reference/bun/test/jest/useFakeTimers). **[unverified]** whether timer faking covers `setTimeout` the way `vi.useFakeTimers` does for these tests.
- **Gaps (no equivalent found in the Bun docs pages reviewed):** `vi.waitFor` (102 uses), `vi.stubEnv`/`unstubAllEnvs` (manual `process.env` save/restore instead), `onTestFinished` (use `afterEach`/`finally`), `vi.resetModules`, and Vitest's `vitest.config.ts` (`env`, `testTimeout: 20_000`, `include`, and the HOME/TMPDIR/PI_CODING_AGENT_DIR isolation in `vitest.config.ts`).

### Conclusion for question 4

Keep Vitest. Bun's `bun:test` is a different runner: it would require rewriting several hundred call sites and re-creating `vitest.config.ts` behavior (environment isolation, per-test timeouts). Running `vitest` through Bun's package manager keeps the test runtime on Node.

---

## 5. Node-specific behavior that matters if tests ran under Bun

Pi runs on Node (`package.json` `engines.node >=22.19.0`; `mise.toml` pins Node 22.19.0; `AGENTS.md` describes Pi's Node-based runtime). Grep counts over `packages/`, `tools/`, `test/`, `scripts/` (`.ts`, `.mjs`, `.js`):

- `process.execPath`: **32** occurrences. Tests spawn Node children using it:
  - `packages/pi-advisor/test/cli.test.ts` (resolves `@earendil-works/pi-coding-agent` bundle via `import.meta.resolve` and spawns `process.execPath` on it).
  - `packages/pi-dap/test/*.test.ts` (uses `process.execPath` as a fake DAP adapter, and `vscode-js-debug.integration.test.ts`).
  - Under `bun test`, `process.execPath` would be **Bun**, so Pi's CLI and DAP adapters would run under Bun instead of Node. Under `vitest` (Node), they stay Node.
- `child_process`: 20; `process.kill`: 24; `SIGKILL`: 38; `SIGTERM`: 11; `process.getuid`: 4; `worker_threads`: 2; `fork(`: 1.
- `import.meta.resolve`: 5; `createRequire`: 4; `jiti`: 6.
- `packages/pi-lsp/test/lsp-server-client.integration.test.ts` spawns `node_modules/.bin/tsc` directly (a Node launcher that `execve`s the native binary via `process.execve`, Node ≥22.15; `typescript@7.0.2` `bin/tsc`).
- `packages/pi-dap` configures the `node` debug profile (`"command": "node"` in `.pi/settings.json`'s `dap` section; `tools/pi-dap-vscode-js-debug` is a Node-based adapter).
- `.pi/settings.json` runs `node` for the DAP adapter and `pnpm` for LSP/formatter commands.

Not found: `process.execve` in repo code, `Bun` global, `node:test`, `NODE_OPTIONS`, `node-pty`, `sqlite`.

**Impact:** Using Bun only as the package manager with `vitest` on Node leaves these semantics unchanged. Running tests with `bun test` or `bun --bun` would change the runtime of child processes and the LSP/DAP integration tests. **Do not run the test suite under Bun's runtime.**

Also check `.pi/settings.json` `formatter` and `lsp` commands that use `pnpm --workspace-root exec` / `pnpm exec oxfmt` and `pnpm exec oxlint --lsp`. These need `bun run`/`bunx` equivalents if Bun replaces pnpm.

---

## 6. GitHub Actions

- **Action:** `oven-sh/setup-bun`. Latest release `v2.2.0` (published 2026-03-14; https://github.com/oven-sh/setup-bun/releases/tag/v2.2.0). Major tag `v2` points at the same commit. Usage: `uses: oven-sh/setup-bun@v2`. README: https://raw.githubusercontent.com/oven-sh/setup-bun/main/README.md
- **Version resolution:** with no input, it reads `package.json` `packageManager` (e.g. `"packageManager": "bun@1.4.4"`), then `engines.bun`, then `latest`. Also `bun-version`, `bun-version-file` (e.g. `.bun-version`, `.tool-versions`), `registries`, `bun-download-url`, `no-cache`, `token`.
- **Caching:** setup-bun does **not** cache package installs. Its `no-cache` input disables caching of the downloaded _executable_, and it outputs `cache-hit`. For dependencies, cache Bun's global cache directory: `~/.bun/install/cache` (or `BUN_INSTALL_CACHE_DIR`) (https://bun.com/docs/pm/global-cache). Typical pattern with `actions/cache` (latest `v6.1.0`, published 2026-06-26; the repo already uses `actions/cache@v6`):

  ```yaml
  - uses: oven-sh/setup-bun@v2
  - uses: actions/cache@v6
    with:
      path: ~/.bun/install/cache
      key: bun-${{ runner.os }}-${{ hashFiles('bun.lock') }}
      restore-keys: bun-${{ runner.os }}-
  - run: bun install --frozen-lockfile
  ```

- **Node is still needed:** `pnpm/setup@v3` with `runtime: node@22.19.0` currently provides Node. Keep a Node setup (e.g. `actions/setup-node`, latest `v7.1.0`, 2026-10-08) pinned to 22.19.0 so Vitest and Pi run on Node. Bun does not replace Node here.
- The release job's `npm install --global npm@">=11.5.1"` (trusted publishing) stays, because changesets publishes through npm.

---

## Verification plan (none of this was run)

Do these in a scratch clone or worktree, not in the main checkout:

1. **Typecheck parity:** install `tsrs@0.20.1-ts7.1.0-beta` in the scratch repo and run `tsrs -p <pkg>/tsconfig.json --noEmit` for all 17 packages plus root. Diff against `tsc --noEmit` with `typescript@7.0.2`. Expect differences from 7.1-beta vs 7.0.2; record them.
2. **LSP:** run `pi-lsp` integration test with `tsrs --lsp -stdio` (command and args change); check `serverInfo.name` assertion.
3. **Bun install:** `bun install` (migrates `pnpm-lock.yaml`), with `tools/*` added to root `workspaces`, `[install] peer = false`, `trustedDependencies`, `minimumReleaseAgeExcludes`. Check that `bun install --frozen-lockfile` works from a clean checkout.
4. **Scripts under Bun:** `bun run verify:push`, `bun run test` (Vitest under Node), `bun run typecheck` (after tsrs change), `bun run lint`; confirm `oxlint` type-aware still runs without the `typescript` package.
5. **Packaging:** replace `scripts/check-package-packs.mjs` pnpm call with `npm pack --json`; compare tarball file lists and `exports` for `@ian-pascoe/pi-utils` against the pnpm-produced tarballs. Run `bun pm pack --dry-run` too to see whether `publishConfig` overrides apply.
6. **Release path:** `changeset version && bun install --lockfile-only` on a bumped branch; `changeset publish --dry-run` (or `npm publish --dry-run` per package) to confirm the `npm` path and provenance settings.
7. **Vitest under Bun:** confirm `bun run test` runs Vitest under Node (check `process.version` in a test) and that issue #25778 does not reproduce with Vitest 5.

---

## Sources

tsrs

- https://github.com/oxc-project/tsrs (repo, README, docs/*); GitHub API https://api.github.com/repos/oxc-project/tsrs ; https://api.github.com/repos/maschwenk/tsrs (redirects)
- https://www.npmjs.com/package/tsrs ; registry https://registry.npmjs.org/tsrs (`npm view tsrs --json`)
- https://www.npmjs.com/package/@maschwenk/tsrs
- Repo tarball read locally: https://codeload.github.com/oxc-project/tsrs/tar.gz/refs/heads/main (copied to `/tmp/tsrs-src/`; files `npm/tsrs/package.json`, `docs/USAGE.md`, `docs/COMPATIBILITY.md`, `docs/DEFAULTS.md`, `docs/LSP.md`, `docs/STATUS.md`, `crates/tsrs_cli/src/lsp.rs`)
- https://raw.githubusercontent.com/oxc-project/tsrs/main/docs/COMPATIBILITY.md
- https://raw.githubusercontent.com/oxc-project/tsrs/main/docs/DEFAULTS.md
- https://raw.githubusercontent.com/oxc-project/tsrs/main/docs/USAGE.md
- https://raw.githubusercontent.com/oxc-project/tsrs/main/docs/LSP.md
- https://raw.githubusercontent.com/oxc-project/tsrs/main/docs/STATUS.md
- https://blog.cloudflare.com/typescript-rust-port/
- TypeScript dist-tags (`npm view typescript dist-tags`): latest 7.0.2, beta 7.1.0-beta, next 7.1.0-dev.20261030.1; `typescript@7.0.2` bin `tsc`; local `node_modules/typescript/package.json`.
- oxlint-tsgolint: local `node_modules/oxlint-tsgolint/README.md` and `package.json` (v7.0.2005); upstream https://github.com/oxc-project/tsgolint

Bun

- https://bun.com/docs/pm/workspaces
- https://bun.com/docs/pm/catalogs
- https://bun.com/docs/pm/lifecycle (trustedDependencies)
- https://bun.com/docs/runtime/bunfig (install.minimumReleaseAge, minimumReleaseAgeExcludes, peer)
- https://bun.com/docs/pm/cli/install (frozen lockfile, peer default, minimum release age, `bun ci`)
- https://bun.com/docs/pm/lockfile (bun.lock text, `--lockfile-only`, pnpm migration)
- https://bun.com/docs/pm/cli/pm (`bun pm pack` options)
- https://bun.com/docs/pm/cli/publish (`bun publish`; provenance errors)
- https://bun.com/docs/runtime (`bun run`, `--filter`, `--bun`, shebang behavior)
- https://bun.com/docs/pm/global-cache (`~/.bun/install/cache`)
- https://bun.com/docs/test/mocks ; https://bun.com/docs/test/dates-times ; https://bun.com/reference/bun/test/jest/useFakeTimers
- https://github.com/oven-sh/bun/issues/25778 (bun run + vitest; closed as duplicate)
- https://github.com/oven-sh/bun/issues/40842 (bun test ignores vitest config)
- npm `bun` latest 1.4.4: https://www.npmjs.com/package/bun

Changesets / Turborepo / Vitest / CI / mise

- Local: `node_modules/@changesets/cli` 3.0.3 `dist/getPublishPlan.mjs` (`getPublishTool`); `node_modules/.pnpm/@manypkg+get-packages@3.1.0/.../manypkg-tools.js` (bun.lock detection); `node_modules/.pnpm/package-manager-detector@1.9.0/.../commands.mjs`
- https://www.npmjs.com/package/@changesets/cli
- https://turborepo.dev/docs/getting-started/installation ; https://turborepo.dev/docs/crafting-your-repository/managing-dependencies ; https://turborepo.dev/docs/reference/prune
- https://github.com/vercel/turborepo/blob/main/crates/turborepo-repository/src/package_manager/bun.rs
- https://vitest.dev/blog/vitest-5 ; https://vitest.dev/guide/migration ; https://vitest.dev/guide/
- https://github.com/oven-sh/setup-bun ; https://raw.githubusercontent.com/oven-sh/setup-bun/main/README.md ; https://github.com/oven-sh/setup-bun/releases/tag/v2.2.0
- https://api.github.com/repos/actions/cache/releases/latest (v6.1.0) ; https://api.github.com/repos/actions/setup-node/releases/latest (v7.1.0)
- https://mise.jdx.dev/lang/bun.html

Repo files consulted (read-only): `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `turbo.json`, `vitest.config.ts`, `tsconfig.json`, `.oxlintrc.json`, `.lintstagedrc.json`, `.npmrc`, `mise.toml`, `.husky/*`, `.github/workflows/{ci,release}.yml`, `.changeset/config.json`, `.pi/settings.json`, `AGENTS.md`, `packages/pi-lsp/{package.json,README.md,test/lsp-server-client.integration.test.ts}`, `packages/pi-utils/package.json`, `scripts/{prepare.mjs,check-package-packs.mjs,check-git-install.mjs}`, `tools/pi-dap-vscode-js-debug/package.json`.

---

## Experimental verification (scratch clone)

Run 2026-10-30 in a scratch clone (`git clone … /tmp/pe-bun`, since deleted), Bun 1.4.4, Node 22.19.0/24.16.0, npm 10.9.3/11.13.0, pnpm 12.9.1. Labels: **[run]** = verified by running; **[docs]** = verified in docs. This section supersedes earlier **[inferred]**/**[unverified]** claims where it contradicts them.

### 1. `publishConfig` overrides: NOT applied by npm or bun (critical) [run]

pi-utils (`main/types/exports` → `./src`, `publishConfig` → `./dist`), `dist` built with `tsc -p tsconfig.build.json` after install. Packed `package/package.json`:

| Command                                         | main / exports["."] in tarball                                                                                                                                        | package.json bytes |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `pnpm pack` (control)                           | `./dist/index.js` / `{types,import}→dist` (applied)                                                                                                                   | 3374               |
| `npm pack --ignore-scripts` (npm 11 and 10.9.3) | `./src/index.ts` / `./src/index.ts` (**not applied**, `publishConfig` kept)                                                                                           | 4359 (= original)  |
| `bun pm pack --ignore-scripts`                  | `./src/index.ts` (**not applied**)                                                                                                                                    | 4359               |
| `npm publish --dry-run`                         | same pack path as `npm pack` (4.4kB package.json in the listing)                                                                                                      | –                  |
| `bun publish --dry-run`                         | refused: `"provenance" in the publishConfig … is not supported yet`. Without provenance it packs package.json 4.33KB (unchanged size), then `missing authentication`. | –                  |

Consequence: published tarballs would point at `src/*.ts`, which is not shipped (`files: [dist…]`) → broken package. npm only honours `access/tag/registry/provenance` from `publishConfig` (docs: https://docs.npmjs.com/cli/v11/configuring-npm/package-json#publishconfig). Needs a rewrite step.

**changesets 3.0.3** (`node_modules/@changesets/cli/dist/getPublishPlan.mjs`, `getPublishTool`): tool type `pnpm`/`yarn` get their own tools; **anything else, incl. bun, uses `npm publish --json --access … --tag …`** (run from the package dir; `publishConfig.directory` is honoured). `@manypkg/get-packages` reports `tool.type = "bun"` for the migrated repo and `detect()` then reads `devEngines.packageManager`. Gotcha: while `devEngines`/`packageManager` still says pnpm, changesets would call `pnpm publish`. Changesets itself never calls `prepack`; npm does, via lifecycle.

### 9. Lifecycle workaround (prepack rewrite + postpack restore) [run + npm source]

`prepack` copied package.json to a backup and applied the overrides at top level; `postpack` restored it. With `npm pack` and `npm publish --dry-run`: **`prepack` and `postpack` both run**, in publish too (publish calls libnpmpack with `dryRun: true`). **The tarball contains the rewritten manifest** (`main ./dist/index.js`, dist exports), and the working tree is restored afterward. But `lib/commands/publish.js` (npm 11.13) **re-reads the manifest from the directory after packing** ("in case it changed", line ~112), i.e. after `postpack` has restored it. So the packument metadata sent to the registry is built from the **restored (src) manifest**, while the tarball package.json is the rewritten one. This is by npm source; I could not observe the upload without a registry (`npm publish --dry-run --json` prints only file lists, not the manifest). Installs read main/exports from the tarball, so they work; registry-side metadata (packument `main/exports/types`) will show src. Omit `postpack` restore to make both agree (CI-only), or publish pre-packed tarballs. `npm publish` of an already-published version fails even in dry-run (E403) — bump the version in a scratch copy to test.

### 2. Lockfile migration [run + docs]

- `bun install` with `pnpm-lock.yaml` present and no `bun.lock` logs `migrated lockfile from pnpm-lock.yaml`; it also **copied `pnpm-workspace.yaml` packages into `workspaces`** ("copied pnpm-workspace.yaml to workspaces in package.json" — `tools/*` was added by hand beforehand anyway). 320 pnpm `name@version` entries → 320 in `bun.lock`; **0 differences**. vitest 5.0.5, turbo 2.11.10, oxlint 1.90.0, pi-coding-agent 1.4.0, vite 8.3.5, typescript 7.0.2 all identical. Script: `/tmp/cmp.mjs` (deleted).
- **Blocker: `vscode-js-debug` tarball cannot be installed by Bun.** The release tarball (`js-debug/…`) contains no `package.json` (pnpm writes `{"_pnpmPlaceholder":…}`). Bun: `error: "package.json" for "vscode-js-debug" failed to open: ENOENT … InstallFailed`; `bun install` exits **1**, but with a lockfile the other 227 packages install and `bun.lock` is saved. With **no** lockfile (fresh resolve) the failure aborts resolution and **no `bun.lock` is written**. Needs a replacement (download/extract script in `tools/pi-dap-vscode-js-debug`, not a dependency) before CI can run `bun install --frozen-lockfile`.
- `trustedDependencies` (`@google/genai, esbuild, protobufjs, tesseract.js` from `allowBuilds: true`): after adding it `bun pm untrusted` reports 0 (before: blocked `@google/genai` preinstall and `protobufjs` postinstall). `tree-sitter-bash`/`zeromq` (`false`) are simply omitted.
- `[install] peer = false` exists (Bun bunfig docs, "install.peer", default true: https://bun.com/docs/runtime/bunfig). With it, the lockfile package set was unchanged except the 8 added tsrs packages.
- **pnpm 12 default `minimumReleaseAge` = 1440 minutes (1 day)** — https://pnpm.io/settings/dependency-resolution (`pnpm config get` prints `undefined` for unset defaults, so docs are the evidence). The repo does not override it, so excludes (exact `@earendil-works/*@1.1.0`) matter. Bun: `[install] minimumReleaseAge` in **seconds** (default disabled) → `86400`; exclude key `minimumReleaseAgeExcludes` (accepts `name` or `name@ver || ver`); https://bun.com/docs/runtime/bunfig. Bunfig keys accepted by 1.4.4 without error.

### 3. Root `prepare` [run]

`bun install` runs the root `prepare` (`$ node scripts/prepare.mjs`), even when the lockfile is unchanged. Runtime = the **`node` on PATH** (24.16 / mise 22.19). If no `node` is on PATH, Bun's node shim runs it **under Bun** (`process.versions.bun=1.4.4`, `execPath` = bun). Without `CI`, husky installed (`core.hooksPath=.husky/_`). With `CI=1` it skips everything (verified earlier by log). Beware: without `CI`, a failed run of the unmodified script starts `sync-reference-repos.sh` (network clones).

### 4. Turbo + Bun [run]

`bunx turbo run typecheck --filter=@ian-pascoe/pi-todo` works with `bun.lock`, no pnpm files, no `packageManager`, **only if `devEngines.packageManager` is `{name:"bun",…}`**. With neither field turbo errors: `Could not resolve workspace. Missing devEngines.packageManager or legacy packageManager field`. So `packageManager` is not needed. `bun run typecheck` (all 18 tasks) passed in 11.8 s.

### 5. Vitest under `bun run` [run + GitHub]

`mise exec node@22.19.0 -- bun run test` in pi-todo: 7 files / 68 tests pass. Inside a test, `process.versions.bun` = `undefined`, `execPath` = node 22.19.0. `bun run test:root -- test/post-checkout-hook.test.ts` passes (the `--` is swallowed; vitest gets the file). **Caveat:** if no `node` is on PATH, or with `bun --bun run`, vitest runs under Bun (`versions.bun=1.4.4`, node shim 26.3.0) — keep Node on PATH (mise/setup-node). oven-sh/bun#25778 ("`bun run` breaks Vitest even when executing with Node") is **closed** (2026-01-03); not reproduced on 1.4.4.

### 6. tsrs parity and speed [run]

`bun add -d tsrs@0.20.1-ts7.1.0-beta` OK (bin `tsrs`; `--version`: `7.1.0-beta (tsrs 0.20.1-ts7.1.0-beta …)`). `tsc --noEmit -p tsconfig.json` vs `tsrs --noEmit -p tsconfig.json` over root + 17 packages (18 projects, sequential, `/usr/bin/time -l`): **both 0 diagnostics, exit 0 everywhere** (no differences). Sanity check with an injected file of 5 errors (TS2322, TS2307, TS2353): **byte-identical output**.

|             | sum wall (18 runs) | max peak RSS | sum peak RSS |
| ----------- | ------------------ | ------------ | ------------ |
| tsc 7.0.2   | 12.05 s            | 1111 MB      | 10.8 GB      |
| tsrs 0.20.1 | 3.78 s             | 419 MB       | 4.3 GB       |

(~3.2× faster, ~2.6× less peak memory on this repo; single warm-ish run, not a benchmark.) `pi-utils` build (`-p tsconfig.build.json --outDir …`): both rc 0, 32 files each, **`diff -r` identical** (.js and .d.ts), and identical to the tsc-built `dist`. `tsrs --help` documents only `-p`, `--fast` ("may differ from pinned TypeScript behavior" — don't use it) and "see `tsc --help`".

### 7. LSP [run]

`initialize` over stdio (JSON-RPC, Content-Length framing): `tsrs --lsp -stdio` → `serverInfo {"name":"typescript","version":"7.1.0-beta"}`, 29 capability keys; `tsc --lsp --stdio` → `{"name":"typescript-go","version":"7.0.2"}`, 29 keys. Both binaries accept `-stdio` and `--stdio`. Note the `name` differs (`typescript` vs `typescript-go`); check `pi-lsp` for name matching. tsrs sends a `window/logMessage` before the response.

### 10. bunx [run]

`bunx --no-install` exists (`--help`: "Skip installation if package is not already installed"; also `--bun`). From `packages/pi-lsp`, `bunx tsc --version` and `bunx --no-install tsc --version` both resolve the root `node_modules/.bin/tsc` (7.0.2). A missing bin with `--no-install` errors: `Could not find an existing '…' binary to run. Stopping because --no-install was passed.` Without the flag a missing package is installed into Bun's global cache (per `--help`), not the project; I did not test that path and found no lifecycle run for locally found bins.

### 8, 12. CI facts [docs]

- `jdx/mise-action`: latest release **v5.2.4** (2026-10-27, GitHub API) → major **v5** (`jdx/mise-action@v5` in its README). `install: true` is the default and runs `mise install`, which reads `mise.toml`, so `bun = "1.4.4"` is installed (https://github.com/jdx/mise-action). I did not run the action.
- Dependabot: ecosystem `bun` is listed (v>=1.1.39; "supports the current default text-based `bun.lock`, but not binary `bun.lockb`") — https://docs.github.com/en/code-security/dependabot/ecosystems-supported-by-dependabot/supported-ecosystems-and-repositories; `cooldown` lists Bun for both default-days and semver-days — https://docs.github.com/en/code-security/dependabot/working-with-dependabot/dependabot-options-reference. The docs show no preview label. Workspace-specific behaviour not tested.

## oxlint type-aware linting with tsrs

Question: can oxlint's type-aware rules and `typeCheck` run on tsrs instead of `oxlint-tsgolint`? Research date 2026-10-30. Experiments ran in the scratch clone `/tmp/pe-oxl` (HEAD `a779453`), deleted afterwards. Versions: oxlint 1.90.0 (npm, 2026-10-27), oxlint-tsgolint 7.0.2005 (npm, 2026-10-22), tsrs 0.20.1-ts7.1.0-beta (npm `latest`, 2026-10-28), tsrs `main` at `e18fb61` (2026-10-30), oxc tag `oxlint_v1.90.0`.

### Summary

- **No supported integration.** oxlint 1.90.0 has no config key, CLI flag or plugin that selects a checker. `options.typeAware` and `options.typeCheck` only enable tsgolint. [verified in source/docs]
- **One undocumented hook works.** `OXLINT_TSGOLINT_PATH` replaces the tsgolint executable. Unreleased `tsrs-lint headless` run through it gave identical diagnostics on this repo. [verified by run]
- **Not released.** `tsrs-lint` is on tsrs `main` (merged 2026-10-29) but not in the v0.20.1 tag, the npm `tsrs` package, or `@tsrs/darwin-arm64`. No date is published. [verified in source; timeline could not verify]

### 1. Native support

- `configuration_schema.json` in the oxlint 1.90.0 tarball: `typeAware` and `typeCheck` "require the `oxlint-tsgolint` package" (lines 17173–17182).
- oxlint's native code runs `<exe> headless` with a JSON payload on stdin, and resolves `<exe>` from `OXLINT_TSGOLINT_PATH` first: https://github.com/oxc-project/oxc/blob/oxlint_v1.90.0/crates/oxc_linter/src/tsgolint.rs (`spawn_tsgolint` ~361–363; `try_find_tsgolint_executable` ~1356–1380). Neither https://oxc.rs/docs/guide/usage/linter/type-aware.html nor the oxlint README mentions the variable (checked 2026-10-30).
- No npm package named `tsrs-lint`, `tsrslint`, `oxlint-tsrs`, `oxlint-tsrslint`, `@tsrs/lint` or `@tsrs/tsrs-lint` exists (`npm view`).

### 2. Plans and workarounds

- oxc PR #27461 "feat(linter): run type-aware rules in-process on tsrs" was closed unmerged on 2026-10-25. Its author replied "This is going to happen by another means" and linked tsrs PR #624 "feat: tsrslint" (https://github.com/oxc-project/tsrs/pull/624), merged 2026-10-29.
- tsrs issue #378 "Add Oxlint support through a tsgolint-compatible headless mode" (https://github.com/oxc-project/tsrs/issues/378) is open, opened by Boshen on 2026-10-13, with no milestone or date. Its scope: match tsgolint's headless interface, preserve diagnostics and fixes, and document backend configuration.
- tsrs issue #855 (open, 2026-10-30; #783 closed) reports that a headless request keeps each tsconfig project's arenas until it ends, so peak memory is the sum over projects (https://github.com/oxc-project/tsrs/issues/855).
- oxc "Plan for 2026 Q4" (https://github.com/oxc-project/oxc/issues/28275), P0 item: content-mapper work will "integrate with Oxlint, TSRS, and type aware linting". No date for a type-aware backend. [could not verify timeline]
- **a. `OXLINT_TSGOLINT_PATH=<tsrs-lint>`** is the only way to put tsrs under the type-aware rules. It needs a source build (`cargo build --release -p tsrs_lint`, Rust 1.99.1). tsrs's own README shows this invocation: https://github.com/oxc-project/tsrs/blob/main/tools/tsgolint/README.md. [verified by run]
- **b. `typeCheck: false` plus `tsrs -p <tsconfig> --noEmit`.** With `typeAware: true` and `typeCheck: false`, zero TS diagnostics appeared on either backend, and tsrs was still invoked for the type-aware rules. [verified by run]
- **c. JS plugins: no.** The plugin context is ESLint-style (`getScope`, `getSourceCode`). Its `parserServices` is documented as "Oxlint does not offer any parser services" (`dist/plugins-dev.d.ts`, 1.90.0 tarball). [verified in source]

### 3. What `typeCheck: true` does

- It sets the tsgolint payload's `report_syntactic` and `report_semantic` (oxc `tsgolint.rs` ~629–641). tsgolint then returns TypeScript's syntactic and semantic diagnostics, which oxlint prints as `typescript(TS2322)` and similar. [verified in source]
- It requires type-aware linting: `oxlint --type-check` alone fails with "The `--type-check` option requires type-aware linting." [verified by run]
- It is redundant only if a separate `tsc` or `tsrs --noEmit` step is the TS gate. tsrs-lint honours the same flags (tsrs `crates/tsrs_lint/src/engine.rs` ~380–390). On the fixture, `typeCheck` and `tsrs -p packages/pi-todo/tsconfig.json --noEmit` (npm tsrs 0.20.1) reported the same four errors as `tsc` 7.0.2 (TS2307, TS2322, TS2801, TS2345). [verified by run]

### Experiment (scratch clone only)

- Setup: `pnpm install --frozen-lockfile` gave oxlint 1.90.0, oxlint-tsgolint 7.0.2005 and typescript 7.0.2. Scratch-only changes: fixture `packages/pi-todo/src/zz-fixture.ts` (4 TS errors and typed-lint violations), and 7 `typescript/*` rules turned on in `.oxlintrc.json`.
- tsrs-lint: `CARGO_PROFILE_RELEASE_LTO=false cargo build --release -p tsrs_lint` at `e18fb61`, about 3 min on 8 cores (14 MB binary). Verified with a logging wrapper that oxlint invoked `headless`, and a bogus path fails with oxlint's own error.

| Config                               | Backend           | Diagnostics | Wall, median of 3 | Process-tree peak RSS, median | `/usr/bin/time -l` max RSS, median |
| ------------------------------------ | ----------------- | ----------: | ----------------: | ----------------------------: | ---------------------------------: |
| Repo `.oxlintrc.json` (fixture only) | tsgolint 7.0.2005 |           8 |            25.7 s |                      1930 MiB |                           1861 MiB |
| same                                 | tsrs-lint         |           8 |             8.4 s |                      1281 MiB |                           1161 MiB |
| + 7 typed rules, typeCheck on        | tsgolint          |         566 |            27.5 s |                      2221 MiB |                           2154 MiB |
| same                                 | tsrs-lint         |         566 |             9.3 s |                      1073 MiB |                            777 MiB |
| all 61 `type_aware` rules, 1 run     | tsgolint          |        9083 |            25.7 s |                             – |                                  – |
| same                                 | tsrs-lint         |        9083 |             9.3 s |                             – |                                  – |

- Parity: `(file, code, line, column, message)` multisets matched exactly in every pair. The 61-rule run fired 40 distinct rules. The other 21 never fired, so their parity is [could not verify]. All 61 names appear in tsrs `registry.rs`.
- Process-tree RSS sums oxlint and its helper, sampled every 0.2 s with `ps`. `/usr/bin/time -l` reports one process's peak.
- Caveats: one 8-core Mac. tsrs-lint was built without LTO, while upstream releases use fat LTO and PGO, so its numbers are conservative. tsgolint 7.0.2005 is built on TypeScript 7.0.2 and tsrs-lint targets 7.1.0-beta (tsrs `docs/COMPATIBILITY.md`). Runs used pnpm-installed binaries, not `bunx` or `npx`.

### Recommendation for this repo

- Keep tsgolint for now. The env-var route needs a source-built binary, and a bad path is fatal (verified).
- To move TS checking to tsrs: set `typeCheck: false`, keep `typeAware: true`, and add a `tsrs -p … --noEmit` CI step.
- Re-check when tsrs #378 closes or an npm tsrs release contains `tsrs-lint`.
- Correction to §6 "Lint" above: `tsrs-lint` is not the default binary, but it can be selected with `OXLINT_TSGOLINT_PATH`.
