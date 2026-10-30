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
- `check` fails unless the top-level fields already match the overrides. `pi-utils`'s `prepack` is `bun run build && node ../../scripts/publish-manifest.mjs check`, so a bare `npm publish` or `npm pack` of an unapplied manifest fails instead of shipping `src` entrypoints.
- `restore` puts the original back byte for byte. Only local checks use it. `pack:check` applies the manifest in place, packs with `npm pack --json` so the real `prepack` runs, restores in a `finally`, and asserts the manifest on disk is byte-identical to before.

The pack check keeps its other assertions: dist entrypoints, a dist-only file list, `publishConfig` reduced to registry options, and an installed tarball that imports and runs. Its scripts assertion becomes "`build` is present", because npm keeps `prepack` in the packed manifest where pnpm removed it.

## vscode-js-debug fixture

Pi DAP's Supported Adapter test runs against the vscode-js-debug release tarball, which pnpm installed as a dependency of `tools/pi-dap-vscode-js-debug`. That tarball has no `package.json`, which pnpm papered over with a placeholder and Bun cannot: `bun install` fails with `ENOENT`, and a fresh resolution then writes no lockfile. The package is replaced by `tools/pi-dap-vscode-js-debug/fixture.json`, holding the version, URL, and SHA-512 integrity (taken from the pnpm lockfile), and `scripts/fetch-vscode-js-debug.mjs`. The script downloads the tarball with one retry after a backoff, verifies the hash, and extracts it to the gitignored `tools/pi-dap-vscode-js-debug/js-debug/`, recording the integrity so a rerun does nothing. It also writes a minimal `package.json` there: pnpm's placeholder had that effect, and without a manifest Node reads the repository root's `"type": "module"` and loads the CommonJS adapter as ESM, which fails on its first `require`. Pi DAP's Vitest global setup runs it, and `prepare.mjs` runs it on development installs (not in CI, not in production installs), warning instead of failing the install when the download fails. The adapter path in `.pi/settings.json` and in the integration test points at the extract, and the Git-install check leaves the extract out of its copy and asserts it is absent after a production install.

## Considered Options

- **Stay on pnpm.** Rejected: this is the migration.
- **Run the tools under Bun (`bun --bun`, `bun test`).** Rejected: the repository's Vitest suites and scripts are verified under Node only, and a missing `node` on `PATH` silently changes the runtime.
- **Publish with `bun publish` or `bun pm pack`.** Rejected: Bun also ignores field overrides, and `bun publish` refuses a `publishConfig` that sets `provenance`.
- **A `prepack` rewrite with a `postpack` restore.** Rejected for the metadata mismatch above.
- **Bundling the vscode-js-debug tarball as a workspace dependency, or committing it.** Rejected: Bun cannot install it, and committing about 1.2 MB of vendored JavaScript for a test fixture is worse than a verified download.
- **`peer = false`, an explicit `vite` dependency, or a hoisted linker.** Rejected, as above.

## Consequences

Contributors need Bun and Node 22.19 together, which `mise install` provides. A tool that finds no `node` fails loudly where Bun would otherwise run it. The first `bun install` downloads the fixture, and Pi DAP's tests need network access on a machine that has never fetched it. Releases must go through `bun run publish-packages`, and a post-release `npm view @ian-pascoe/pi-utils exports` confirms the registry metadata names `dist`. Pi Guardian's sensitive paths do not yet include `bunfig.toml`, whose `preload` option runs code; that is follow-up work.

The typechecker is a separate follow-up: replacing `typescript` with `tsrs`, which the research measured at identical diagnostics and `dist` output. It lands in a later change that amends this ADR.
