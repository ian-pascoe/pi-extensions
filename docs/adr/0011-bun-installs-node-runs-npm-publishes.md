# Bun installs and runs the repository; Node runs its tools; npm publishes

The repository moved from pnpm to Bun for installing dependencies and running package scripts. This ADR defines the two terms the rest of the repository uses for the split, and the decisions that follow from it. The evidence, including what was run and what was only read in documentation, is in [the Bun and tsrs research](../research/bun-and-tsrs.md).

- **Tool runtime** is Node. It runs Vitest, the repository scripts under `scripts/`, Changesets, and Pi. Bun installs dependencies and starts `bun run <script>`; it does not run the tools.
- **Publish path** is npm. Changesets calls `npm publish` with provenance, and consumers install with npm. `bun publish` is never used.

## Decision

`bun.lock` replaces `pnpm-lock.yaml`, migrated by `bun install`, with every resolved `name@version` kept: the only difference is the removed vscode-js-debug tarball (see its section below). Root `workspaces` stays `["packages/*"]`; the migrator also copies `tools/*` from `pnpm-workspace.yaml`, and that entry is reverted because `tools/` holds no workspace package. `pnpm-workspace.yaml` is deleted. `devEngines.packageManager` names `bun` `^1.4` with `onFail: "ignore"`, which Turborepo and Changesets read to detect the package manager, so no `packageManager` field is set. `mise.toml` pins Node 22.19.0 and Bun 1.4.4. Husky hooks, CI, and the release workflow call `bun run`, CI installs with `bun install --frozen-lockfile`, and Dependabot uses the `bun` ecosystem with a one-day cooldown.

`bunfig.toml` sets one option under `[install]`, `minimumReleaseAge = 86400` seconds, which keeps pnpm 12's default of 1440 minutes. The earlier `minimumReleaseAgeExclude` list named exact `1.1.0` releases that are long past the delay, so no `minimumReleaseAgeExcludes` carries over. Two options are deliberately left at their defaults:

- **`peer` stays on.** An earlier draft set `peer = false`, copying the `legacy-peer-deps` line in `.npmrc`. That file governs npm installs only: consumers' installs and the pack and Git-install checks. The pnpm lockfile had `autoInstallPeers: true`, so pnpm installed peers, and Bun's default is the faithful match. With `peer = false`, Bun skips `vite`, a required peer of Vitest, and every test run fails at startup with `Cannot find package 'vite'`, because the migrated lockfile keeps `vite` only as an orphaned entry. An explicit root `vite` dependency was rejected as a workaround for a wrong setting.
- **The linker stays isolated.** Migrating a pnpm lockfile writes `configVersion: 1`, which selects Bun's isolated linker (`node_modules/.bun`), the same strict layout pnpm used. A hoisted linker would let undeclared imports resolve.

Root `trustedDependencies` is exactly `["@google/genai", "esbuild", "protobufjs", "tesseract.js"]`, the packages `allowBuilds` allowed; `bun pm untrusted` reports none. `tree-sitter-bash` and `zeromq`, which `allowBuilds` denied, are in neither lockfile, so nothing installs them, and leaving them out of `trustedDependencies` keeps them denied if they ever appear. `.npmrc` stays, and its comment says that npm installs and publishes still read it.

## Tool runtime is Node

Vitest 5 and the scripts are tested under Node only. `bun run <script>` starts the `node` on `PATH` for `node ...` scripts and for tool shebangs, so with Node 22.19 installed by `mise` the tools run under Node, as the research confirmed: inside a test, `process.versions.bun` is `undefined`. With no `node` on `PATH`, or with `bun --bun run`, Bun substitutes its own runtime. `scripts/assert-node-runtime.mjs` therefore throws when `process.versions.bun` is set, and the root `vitest.config.ts` (which every package config reuses), `check-package-packs.mjs`, and `check-git-install.mjs` call it. `bun test` is Bun's own runner and ignores the Vitest configuration, so it is not used either.

## Publish path is npm

Changesets 3.0.3 publishes with `npm publish` for every package manager except pnpm and Yarn, so Bun needs no change to the release job. The release job keeps `npm install --global npm@">=11.5.1"` for trusted publishing, and the artifact-check jobs now install it too, so the pack check runs the npm that publishes. The `version-packages` script ends with `bun install --lockfile-only`.

## Publish manifest

[ADR 0002](0002-publish-pi-extensions-as-source-typescript.md) had `publishConfig` substitute `pi-utils`'s `dist` entrypoints when pnpm packs. npm and Bun do not: they honour only registry options (`access`, `provenance`, `tag`, `registry`) from `publishConfig`, and a packed tarball would point `main` and `exports` at `src`, which it does not ship. A `prepack` rewrite with a `postpack` restore is not enough either. npm reads the manifest again after packing, and `postpack` has restored it by then, so the tarball would carry `dist` while the registry metadata carried `src`.

`scripts/publish-manifest.mjs` has three modes for any workspace package whose `publishConfig` overrides `main`, `types`, or `exports`:

- `apply` lifts the overrides to the top level, as pnpm did, leaves only registry options in `publishConfig`, and keeps the original manifest beside it. It never restores afterwards. `publish-packages` runs `node scripts/publish-manifest.mjs apply && changeset publish`.
- `check` fails unless the top-level fields already match the overrides. `pi-utils`'s `prepack` is `bun run build && node ../../scripts/publish-manifest.mjs check .`, so a bare `npm publish` or `npm pack` of an unapplied manifest fails instead of shipping `src` entrypoints.
- `restore` puts the original back byte for byte. Only local checks use it. `pack:check` applies the manifest in place, packs with `npm pack --json` so the real `prepack` runs, restores in a `finally`, and asserts the manifest on disk is byte-identical to before.

The pack check keeps its other assertions: dist entrypoints, a dist-only file list, `publishConfig` reduced to registry options, and an installed tarball that imports and runs. Its scripts assertion becomes "`build` is present", because npm keeps `prepack` in the packed manifest where pnpm removed it.

## vscode-js-debug fixture

Pi DAP's Supported Adapter test runs against the vscode-js-debug release tarball, which pnpm installed as a dependency of `tools/pi-dap-vscode-js-debug`. That tarball has no `package.json`, which pnpm papered over with a placeholder and Bun cannot: `bun install` fails with `ENOENT`, and a fresh resolution then writes no lockfile. The package is replaced by `tools/pi-dap-vscode-js-debug/fixture.json`, holding the version, URL, and SHA-512 integrity (taken from the pnpm lockfile), and `scripts/fetch-vscode-js-debug.mjs`. The script downloads the tarball with one retry after a backoff, verifies the hash, and extracts it to the gitignored `tools/pi-dap-vscode-js-debug/js-debug/`, recording the integrity so a rerun does nothing. It also writes a minimal `package.json` there: pnpm's placeholder had that effect, and without a manifest Node reads the repository root's `"type": "module"` and loads the CommonJS adapter as ESM, which fails on its first `require`. Pi DAP's Vitest global setup runs it, and `prepare.mjs` runs it on development installs (not in CI, not in production installs), warning instead of failing the install when the download fails. The adapter path in `.pi/settings.json` and in the integration test points at the extract, and the Git-install check leaves the extract out of its copy and asserts it is absent after a production install.

## Typechecker

> **Amended** to record the typechecker (tsrs), and again to move the type-aware lint rules to tsrslint ([#499](https://github.com/ian-pascoe/pi-extensions/issues/499)).

`tsrs` replaces the `typescript` package as the only source of TypeScript diagnostics, for the `typecheck` and `typecheck:root` tasks and for the language server in `.pi/settings.json` (`bunx --no-install tsrs --lsp --stdio`). It is a Rust port of TypeScript 7 whose `tsrs` binary takes the same `-p` and `--noEmit` flags; the scripts use no other flags, and in particular not `--fast`, which its help text says "may differ from pinned TypeScript behavior". The `pi-utils` `build` script is `tsrs -p tsconfig.build.json`. The evidence is below. The speed and memory figures and the first parity check come from [the research](../research/bun-and-tsrs.md); the swap re-checked parity and the `dist` output and timed the typecheck tasks.

- **Parity.** `tsc --noEmit` from `typescript` 7.0.2 and `tsrs --noEmit` report no diagnostics, with exit status 0, for the root and all 17 packages (research; the swap re-checked all 18 projects). In the research, an injected file with five errors produced byte-identical output.
- **Speed and memory.** Summed over the 18 projects, run one after another, `tsc` took 12.05 s at 1111 MB peak RSS and `tsrs` took 3.78 s at 419 MB (research). The swap measured `turbo run typecheck:root typecheck --force` at about 29–34 s with `tsc` and 3.7–7.6 s with `tsrs`.
- **`dist`.** `pi-utils` built with `tsrs -p tsconfig.build.json` has the same 32 files as the `tsc` build, and `diff -r` finds them identical (re-checked in the swap).
- **Language server.** `tsrs --lsp` reports `serverInfo.name` as `typescript` (`tsc --lsp` reported `typescript-go`). The pi-lsp integration tests spawn `node_modules/.bin/tsrs` and assert the name only, not the version.
- **Known gap.** tsrs 0.20.1's `textDocument/documentSymbol` omits import bindings, so this repository's own LSP outlines do not show imports at `depth: "all"`. pi-lsp's handling of import bindings is proven against the fake server in `lsp-tool.test.ts`, not a real one.

The version is pinned exactly, with no caret: its string carries the TypeScript version it ports (`0.20.1-ts7.1.0-beta` ports 7.1.0-beta), so a range could silently change the checker's TypeScript version. Upgrading is a deliberate edit to that line.

`.oxlintrc.json` sets `typeCheck: false` and keeps `typeAware: true`, so oxlint runs the type-aware rules only and `tsrs` is the sole TypeScript gate.

The type-aware rules run on [tsrslint](https://github.com/maschwenk/tsrslint) (`@maschwenk/tsrslint`, pinned exactly at 0.1.6), a community Rust port of tsgolint 7.0.2005's 61 rules on tsrs, instead of `oxlint-tsgolint`. This is interim: it lasts until [oxc-project/tsrs#378](https://github.com/oxc-project/tsrs/issues/378) ships an official oxlint backend, when the rules move to it ([#499](https://github.com/ian-pascoe/pi-extensions/issues/499)). oxlint 1.90.0 has no setting that selects its backend. It reads the undocumented `OXLINT_TSGOLINT_PATH` before looking for `node_modules/.bin/tsgolint`. `mise.toml` sets that variable under `[env]` to `{{config_root}}/node_modules/.bin/tsrslint`, so the CLI, lint-staged, CI (mise-action exports `[env]` by default) and the oxlint language server Pi starts all inherit it. That path is the package's Node launcher. The launcher `execve`s the platform binary from Bun's isolated store, whose path carries the version. It adds about 35 ms per run. `oxlint-tsgolint` is removed, so a missing variable fails loudly in CI instead of silently falling back.

- **Parity.** With all 61 type-aware rules enabled and `typeCheck: true`, tsgolint 7.0.2005 and tsrslint 0.1.6 reported the same 8,901 diagnostics on this repository: their (file, code, line, column, message) multisets are identical. 34 distinct codes fired.
- **Speed and memory.** `oxlint` with the repository config, median of 3 on one 8-core Mac: tsgolint 10.3 s at 1,713 MiB process-tree peak RSS, tsrslint 3.6 s at 2,052 MiB (sampled every 0.1 s with `ps`). Peak memory is not lower here; [oxc-project/tsrs#855](https://github.com/oxc-project/tsrs/issues/855) reports that headless memory grows with the number of tsconfig projects.
- **Platforms.** tsrslint ships binaries for macOS arm64 and Linux x64 and arm64 (glibc) only. Windows and Intel macOS cannot run the type-aware rules.
- **Version drift.** tsrslint 0.1.6 embeds a tsrs that ports TypeScript 7.1-dev, while the `tsrs` typechecker is 0.20.1 (7.1.0-beta), so printed types in rule messages can still differ slightly from `tsrs` output.

Rejected:

- **Building `tsrs-lint` from oxc-project/tsrs `main`.** It needs a Rust toolchain on every contributor and CI machine and builds an unreleased commit; tsrslint ships prebuilt npm binaries with provenance.
- **A wrapper script that sets the variable and runs oxlint.** Every oxlint entry point (scripts, lint-staged, the `.pi/settings.json` language server) would have to call it, whereas `[env]` reaches them all unchanged.
- **Keeping `oxlint-tsgolint` as a fallback.** A run without mise's environment would silently lint on the old backend.
- **Keeping `typeCheck: true` as a second checker.** It is redundant, since `tsrs` already matches `tsc`, and it would repeat every TypeScript error in the oxlint output and in the LSP, where oxlint is a second server alongside `tsrs`.

## Considered Options

- **Stay on pnpm.** Rejected: this is the migration.
- **Run the tools under Bun (`bun --bun`, `bun test`).** Rejected: the repository's Vitest suites and scripts are verified under Node only, and a missing `node` on `PATH` silently changes the runtime.
- **Publish with `bun publish` or `bun pm pack`.** Rejected: Bun also ignores field overrides, and `bun publish` refuses a `publishConfig` that sets `provenance`.
- **A `prepack` rewrite with a `postpack` restore.** Rejected for the metadata mismatch above.
- **Bundling the vscode-js-debug tarball as a workspace dependency, or committing it.** Rejected: Bun cannot install it, and committing about 1.2 MB of vendored JavaScript for a test fixture is worse than a verified download.
- **`peer = false`, an explicit `vite` dependency, or a hoisted linker.** Rejected, as above.

## Consequences

Contributors need Bun and Node 22.19 together, which `mise install` provides. A tool that finds no `node` fails loudly where Bun would otherwise run it. The first `bun install` downloads the fixture, and Pi DAP's tests need network access on a machine that has never fetched it. Releases must go through `bun run publish-packages`, and a post-release `npm view @ian-pascoe/pi-utils exports` confirms the registry metadata names `dist`. Pi Guardian's sensitive paths do not yet include `bunfig.toml`, whose `preload` option runs code; that is follow-up work.

The typechecker was a separate follow-up, replacing `typescript` with `tsrs`, and landed as an amendment (Typechecker, above). The type-aware lint rules run on tsrslint in the interim, and move to the official tsrs backend when oxc-project/tsrs#378 lands, tracked in [#499](https://github.com/ian-pascoe/pi-extensions/issues/499). Running oxlint outside mise (without `OXLINT_TSGOLINT_PATH`) fails, because the repository installs no `tsgolint`, unless one is on `PATH`.
