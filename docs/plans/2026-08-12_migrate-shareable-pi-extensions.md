# Migrate shareable Pi extensions into the monorepo

**Status:** Ready for approval

## Outcome

Copy six independently installable Pi extension packages into `packages/*`, preserving behavior while replacing the two Rolldown distributions with source TypeScript packages. Work only in this repository; treat every source repository, loose extension, and Pi settings file as read-only.

Read before implementation:

- [`../adr/0001-package-naming-strategy.md`](../adr/0001-package-naming-strategy.md)
- [`../adr/0002-publish-pi-extensions-as-source-typescript.md`](../adr/0002-publish-pi-extensions-as-source-typescript.md)
- [`../agents/domain.md`](../agents/domain.md)

Publishing is a post-migration human operation. Implementation prepares packages, Changesets, CI, and a gated OIDC release workflow; it publishes nothing and edits no user configuration.

## Inputs and targets

| Package                            | Read-only source                              | Source revision                                                                      | Target                          | Initial manifest version |
| ---------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------- | ------------------------ |
| `pi-adaptive-thinking`             | `~/src/pi-adaptive-thinking`                  | `4bc5dbe6dfe3d9108049d0002dc3dcfe51725764`                                           | `packages/pi-adaptive-thinking` | `0.1.1`                  |
| `pi-byterover`                     | `~/src/pi-byterover`                          | `fe841f6990522148bc6898b3f7fd7a11fdad5074`                                           | `packages/pi-byterover`         | `0.2.4`                  |
| `@ian-pascoe/pi-minimal-subagents` | `~/.pi/agent/extensions/minimal-subagents/`   | Aggregate SHA-256 `d7ed73edf599873d09c92c347bdfba3b0df3e4a456ae46e174cf9d2cbfe822e6` | `packages/pi-minimal-subagents` | `0.1.0`                  |
| `@ian-pascoe/pi-bible-verses`      | `~/.pi/agent/extensions/bible-verses/`        | Aggregate SHA-256 `4d239c6c3a1db8996870922674f1709c2f4bd4688c8f6df238eb0ed6e67baa3a` | `packages/pi-bible-verses`      | `0.1.0`                  |
| `@ian-pascoe/pi-tps-tracker`       | `~/.pi/agent/extensions/tps-tracker.ts`       | SHA-256 `4f21b5ea72f8afb98a83062f37891a8c7cb2122322f6510926442021df840f9c`           | `packages/pi-tps-tracker`       | `0.1.0`                  |
| `@ian-pascoe/pi-git-status-widget` | `~/.pi/agent/extensions/git-status-widget.ts` | SHA-256 `8f2e2e718643aaa8ba8c3635f83751bbf1f847ffc98a3d29be63309b15daa611`           | `packages/pi-git-status-widget` | `0.1.0`                  |

`pi-byterover` currently has one untracked `.brv/context-tree/facts/...` file. It is source state, not package input. Copy only the paths named below.

## Package contract

Every package must have:

- its decided `name` and initial `version`, `private: false`, a concrete description, and `pi`, `pi-package`, and `pi-extension` keywords;
- `license: "MIT"` and `author: "Ian Pascoe <ian.g.pascoe@gmail.com>"`;
- a package-local MIT license carrying `Copyright 2026 Ian Pascoe`, while preserving the existing ByteRover notice verbatim;
- for Bible Verses, an explicit README distinction between MIT-licensed package code and the embedded public-domain/CC0 translation text, whose source and rights notices remain authoritative;
- `type: "module"` and `engines.node: ">=22.19.0"`;
- `files: ["src", "README.md", "LICENSE"]`;
- `pi.extensions: ["./src/index.ts"]`;
- public `publishConfig` with provenance;
- `homepage`, `bugs`, and repository metadata targeting `https://github.com/ian-pascoe/pi-extensions`, with the repository `directory` set to its `packages/<directory>`;
- `test: "vitest run --config ../../vitest.config.ts --root ."` and `typecheck: "tsc --noEmit -p tsconfig.json"`, with no build script;
- wildcard peers only for Pi-bundled modules it imports;
- no `main`, `types`, `exports`, `dist`, Rolldown, or declaration build.

Runtime libraries stay in `dependencies`; `tiktoken` is an optional dependency. The root pins Pi `0.84.1` and its `typebox` `1.3.7` development baseline. Package-local third-party test dependencies remain package-local.

| Package           | Runtime dependencies                         | Optional dependencies | Pi-bundled peers                                                 | Package-local development dependencies |
| ----------------- | -------------------------------------------- | --------------------- | ---------------------------------------------------------------- | -------------------------------------- |
| Adaptive Thinking | `proper-lockfile@^4.1.2`                     | —                     | `pi-ai`, `pi-coding-agent`, `typebox`                            | `@types/proper-lockfile@4.1.4`         |
| ByteRover         | `@byterover/brv-bridge@^1.2.0`, `zod@^4.4.3` | —                     | `pi-ai`, `pi-coding-agent`, `typebox`                            | `byterover-cli@3.16.1`                 |
| Minimal Subagents | —                                            | —                     | `pi-agent-core`, `pi-ai`, `pi-coding-agent`, `pi-tui`, `typebox` | —                                      |
| Bible Verses      | —                                            | —                     | `pi-coding-agent`                                                | —                                      |
| TPS Tracker       | —                                            | `tiktoken@1.0.22`     | `pi-coding-agent`                                                | —                                      |
| Git Status Widget | —                                            | —                     | `pi-coding-agent`                                                | —                                      |

Names beginning with `pi-` expand to their full `@earendil-works/*` package names; `typebox` remains unscoped. All peer ranges use `"*"`.

## Implementation sequence

### 1. Lock provenance and establish a red baseline

Create `docs/migration-provenance.md` containing the source URLs, revisions, loose-file paths and hashes above, the explicit copy boundary, and the statement that the first commit containing the copied files is their monorepo provenance point. Preserve historical links in the two copied changelogs. Record `git rev-parse HEAD` and `git status --porcelain=v1 --untracked-files=all` for both standalone sources.

Run standalone baseline tests from temporary `git archive` exports so dependency installation and tests cannot write into the sources. Record any pre-existing failure in the provenance document rather than weakening a migrated assertion.

Reproduce the current Minimal Subagents hash over its 16 TypeScript files and README with this exact path order and aggregation:

```bash
cd ~/.pi/agent/extensions
find minimal-subagents -type f \( -name '*.ts' -o -name README.md \) -print0 \
  | sort -z \
  | xargs -0 sha256sum \
  | sha256sum
```

The former top-level `~/.pi/agent/extensions/minimal-subagents.ts` no longer exists and is not an input. Reproduce the Bible Verses aggregate with:

```bash
cd ~/.pi/agent/extensions
find bible-verses -type f -name '*.ts' -print0 \
  | sort -z \
  | xargs -0 sha256sum \
  | sha256sum
```

Record the per-file SHA-256 output feeding both aggregates in the provenance document. Recompute all loose-source hashes and halt for review if any differ. Capture existence and SHA-256 only—not contents—for global `~/.pi/agent/settings.json` and project `.pi/settings.json` in a temporary before-state file for the final mutation check.

**Complete when:** every copied file has a recorded origin; source revisions/hashes match; baseline test results are known; the ByteRover `.brv` state is explicitly excluded.

### 2. Establish the root workspace and toolchain contract

Update these root files:

- `package.json`
  - add npm-compatible `workspaces: ["packages/*"]` alongside `pnpm-workspace.yaml`;
  - derive the ordered root `pi.extensions` list from the Inputs and targets table, in table order, as `./<Target>/src/index.ts`; use this same six-path list—including the leading `./`—for loader assertions, so Git installation and validation share one authority;
  - keep the root private and add Node `>=22.19.0`;
  - keep Pi packages as exact `0.84.1` root development dependencies, add exact `typebox@1.3.7`, and remove root peer dependencies;
  - add `@changesets/cli` and the scripts listed below.
- `tsconfig.json`
  - use NodeNext module and resolution semantics, Node types, strict/no-emit options, and exclude package trees from the root invocation;
  - package configs override the inherited exclusion.
- `turbo.json`
  - remove every `^build` dependency;
  - retain cacheable package `test` and `typecheck` tasks.
- `vitest.config.ts`
  - make root runs select `test/**/*.test.ts` only;
  - package scripts run the same config with their package directory as `--root`.
- `.gitignore`
  - cover `node_modules`, `dist`, `.turbo`, coverage, tarballs, and temporary pack/install output.
- `.nvmrc`
  - pin `22.19.0`, the declared minimum.
- `pnpm-workspace.yaml`
  - retain the reviewed build-script allowlist;
  - after adding `byterover-cli`, inspect `pnpm ignored-builds` and approve only scripts required by the pinned CLI smoke, expected to include `esbuild` if its platform binary requires installation.

Use these root script responsibilities:

| Script                           | Responsibility                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------ |
| `typecheck`                      | Root `tsc --noEmit`, then `turbo typecheck`                                    |
| `test`                           | Root `vitest run`, then `turbo test`                                           |
| `test:load`                      | Run only `test/extension-entrypoints.test.ts`                                  |
| `pack:check`                     | Run `scripts/check-package-packs.mjs`                                          |
| `git-install:check`              | Run `scripts/check-git-install.mjs`                                            |
| `verify`                         | Format check, lint, typecheck, test, pack/install check, and Git-install check |
| `changeset` / `changeset:status` | Create or inspect independent Changesets                                       |
| `version-packages`               | Apply Changesets and refresh `pnpm-lock.yaml`                                  |
| `publish-packages`               | Invoke `changeset publish`; CI gates its use                                   |

Keep Husky useful for contributors while making Pi Git installation safe. Replace direct `prepare: husky` with `scripts/prepare.mjs`: install hooks only for a non-production checkout with Husky available, and exit successfully for Pi's production dependency install.

Pi `0.84.1` defaults Git-package dependency setup to `npm install --omit=dev`. A configured custom `npmCommand` may run a full install, so both modes must remain valid.

**Complete when:** root installation/configuration succeeds; root typechecking passes; Turbo no longer expects build outputs; the guarded prepare script succeeds both with and without Husky; every ignored dependency build is either approved by name or documented as intentionally unnecessary.

### 3. Copy Adaptive Thinking

Create `packages/pi-adaptive-thinking/{src,test}` and map files as follows:

- production `src/{index,config,config-loader,thinking-levels}.ts` → `src/`;
- `src/*.test.ts` → matching `test/*.test.ts`;
- `README.md` and `CHANGELOG.md` → package root;
- create a package-local MIT `LICENSE`, because the source declares MIT but has no license file.

Create `package.json` and `tsconfig.json` from the package contract. The package config extends the root, sets `rootDir: "."`, includes `src/**/*.ts` and `test/**/*.ts`, and overrides `exclude` so the root package exclusion is not inherited.

Create `CONTEXT-MAP.md` and `packages/pi-adaptive-thinking/CONTEXT.md` before naming new tests. Define the package-specific terms **Session Baseline** and **Temporary Thinking Level**. Later package steps extend the map as their contexts are created.

Convert production relative imports to `.js` specifiers:

- `index.ts` → `./config-loader.js`, `./thinking-levels.js`;
- `config-loader.ts` → `./config.js` and matching type export.

After moving tests, import source through `../src/*.js`. Normalize touched built-ins to `node:fs`, `node:os`, and `node:path`. In the package README use `pi -e ./src/index.ts`; reserve repository-relative `pi -e ./packages/pi-adaptive-thinking/src/index.ts` for the root README. Retain configuration and behavior documentation.

Preserve the `set_thinking_level` contract, project-over-global configuration, settings locking/recovery, temporary reset, session baseline, quiet notifications, and prompt text. Keep tests proving temporary and persistent operations do not leave an unintended global `defaultThinkingLevel`.

Exclude standalone `.git`, `.github`, `.changeset`, `.husky`, `.brv`, lockfiles, `dist`, Rolldown/build configs, generated release files, and standalone formatter/linter configs.

**Complete when:** copied tests pass from `test/`; NodeNext resolves every import; package source has no test/build artifact; the README contains no `dist` or package-local build instruction.

### 4. Copy ByteRover

Create `packages/pi-byterover/{src,test}` and copy:

- production `src/{index,config,config-loader,gitignore,lru-cache,messages,recall,tools}.ts` → `src/`;
- each matching source test → `test/`;
- `README.md`, `CHANGELOG.md`, and `LICENSE` → package root.

Create its manifest/config from the package contract. Production imports already use `.js`; change moved tests from `./<module>.js` to `../src/<module>.js`. Update README repository links and source-development commands while retaining the `brv` prerequisite and all configuration/tool documentation.

Create its `CONTEXT.md`, add it to `CONTEXT-MAP.md`, and define **Recall**, **Curation**, and **Untrusted Recalled Memory** before naming new tests.

Preserve the `BrvBridge` mocking in unit tests and retain coverage for configuration precedence, `.brv/.gitignore` normalization, quiet-aware failures, context injection as untrusted material, recall/persist deduplication, asynchronous curation, manual tools, and timeout overrides.

Add `test/byterover-cli.integration.test.ts` as a narrow executable smoke test:

1. Resolve `byterover-cli/package.json`, read its `bin.brv`, and invoke that package-local file with Node.
2. Isolate `HOME`, XDG config/data/cache paths, and `cwd` under a temporary directory; disable update notification; enforce a timeout.
3. Run only `brv --version` and assert success plus version `3.16.1`.
4. Create an empty temporary `.brv` directory and verify a real `BrvBridge` reports `ready()` without credentials or global state.
5. Remove the temporary tree in `finally`.

Do not use `brv init`: in `byterover-cli@3.16.1` it intentionally exits with "use: brv vc init". Do not use `brv vc init` in CI because it starts a daemon. Mocked bridge tests remain the behavioral integration surface.

This deliberately reduced integration proves the pinned package supplies an executable CLI and that the real bridge recognizes isolated project state; it does not exercise a bridge-spawned CLI operation. Full operations require the daemon or external behavior excluded by the offline test contract and remain covered by argument-level bridge mocks.

Exclude all standalone tooling/state, including the currently untracked `.brv` fact.

**Complete when:** all migrated unit tests and the isolated CLI smoke pass; the package resolves the installed CLI without `PATH`; no test starts a daemon, accesses the network, or writes outside its temporary tree.

### 5. Copy Minimal Subagents

Create `packages/pi-minimal-subagents/{src,test}`, then create its `package.json`, `tsconfig.json`, and MIT `LICENSE` from the package contract.

Map:

```text
~/.pi/agent/extensions/minimal-subagents/index.ts
  → packages/pi-minimal-subagents/src/index.ts
every ~/.pi/agent/extensions/minimal-subagents/*.ts other than index.ts
  → packages/pi-minimal-subagents/src/<same basename>.ts
~/.pi/agent/extensions/minimal-subagents/README.md
  → packages/pi-minimal-subagents/README.md
```

The current source is one directory: a thin `index.ts`, 15 sibling helper modules, and a README. Keep that layout flat beneath target `src/`; `minimal-subagents-extension.ts` resolves `new URL("./index.ts", import.meta.url)` as the canonical coordinator entrypoint, so nesting helpers would break child resource filtering. Retain every `.js` local specifier and helper-module name. Extend the existing configuration README with npm/Git installation, persistent child sessions, capability/depth behavior, optional `trash`-then-unlink deletion, and the exact coordinator tools: `subagent`, `agent_message`, `subagent_wait`, `subagent_status`, `subagent_cancel`, and `subagent_delete`.

Create its `CONTEXT.md`, add it to `CONTEXT-MAP.md`, and define **Root Agent**, **Child Agent**, **Launch Contract**, **Registry**, and **Delivery Evidence** before naming tests.

Characterize existing seams without extracting a new public API:

- `test/capabilities.test.ts`: model eligibility, thinking suffixes, tool ceilings, fanout and depth;
- `test/config.test.ts`: global/project role merging, deletion, defaults and warnings;
- `test/context.test.ts`: committed snapshots, compact/omitted context and image detection;
- `test/registry.test.ts`: event replay, checkpoints, delivery evidence and tombstones;
- `test/coordinator.test.ts`: fake session factory/root endpoint/registry writer covering spawn authorization, wait/abort, delivery, cancellation, recursion and deletion; cover `prepareFork()` canceling active root children, cloning every session, and producing failed-subtree placeholders without cloning descendants after an ancestor failure;
- `test/fork-lifecycle.test.ts` and `test/shutdown.test.ts`: canonical fork snapshot lookup plus canceling non-reload shutdown and drain-to-idle reload shutdown;
- `test/rendering.test.ts` and `test/ui.test.ts`: bounded lines, summaries, fake-timer interval/cooldown disposal, and non-TUI behavior;
- `test/sessions.test.ts`: temporary session files, child identity flush, coordinator-entrypoint filtering, missing tools, and mocked `trash` fallback;
- `test/tools.test.ts`: six tools for root/fanout callers and exactly `agent_message`, `subagent_wait`, and `subagent_status` for non-fanout children;
- `test/usage.test.ts`: optional usage cloning and field-by-field token/cost aggregation without retained mutable input references;
- `test/extension.test.ts`: recording Pi API plus awaited `session_start`/shutdown, two renderers, `session_start`, `session_before_fork`, `message_end`, and `session_shutdown`, including delivery reconciliation after tool/custom messages, all six root tools, stored fork-snapshot consumption, and replay-plus-clone fallback when no stored snapshot exists.

Preserve the process-global fork snapshot, canonical entrypoint filtering, JSONL registry/identity records, reload wait behavior, hierarchy restoration, and UI disposal order. A non-settling child delaying reload is current behavior, not migration cleanup.

Before final validation, compare each of the 16 target TypeScript files byte-for-byte with its mapped source. The package README is intentionally extended and is not part of this equality check.

**Complete when:** the coordinator/lifecycle suite runs without model credentials or real Pi settings; all six tools load through `src/index.ts`; `src/` contains exactly 16 flat TypeScript files including `index.ts`, with no nested helper directory; every target TypeScript file matches its mapped source; child resource loading excludes that exact resolved coordinator entrypoint.

### 6. Copy Bible Verses

Create `packages/pi-bible-verses/{src,test}` and map only:

```text
~/.pi/agent/extensions/bible-verses/index.ts
  → packages/pi-bible-verses/src/index.ts
~/.pi/agent/extensions/bible-verses/bible-verse-picker.ts
  → packages/pi-bible-verses/src/bible-verse-picker.ts
~/.pi/agent/extensions/bible-verses/bible-translations.ts
  → packages/pi-bible-verses/src/bible-translations.ts
~/.pi/agent/extensions/bible-verses/bible-verses.ts
  → packages/pi-bible-verses/src/bible-verses.ts
```

Create `@ian-pascoe/pi-bible-verses@0.1.0` from the package contract. It has no runtime library dependency and peers only on `@earendil-works/pi-coding-agent: "*"`. All local imports already use `.js` specifiers; retain them.

Create its `CONTEXT.md`, add it to `CONTEXT-MAP.md`, and define **Offline Verse Pool**, **Recent Passage Window**, **Working Message**, and **Translation Provenance** before naming tests. The package README must use `pi -e ./src/index.ts` and explain:

- the offline 291-passage rotation and process-scoped exclusion of the 20 most recently selected passage IDs;
- the working-message format `` `${text} — ${reference} (${translation})` `` and automatic clear at turn end;
- the absence of settings, network access, and external data loading;
- all seven exact `bibleTranslationMetadata` records, including name, edition, license, `staticEmbeddingAllowed`, source URL, rights URL, source-archive SHA-256, and provenance notice.

Copy `bibleVerseMessages` and `bibleTranslationMetadata` exactly. The static pool remains `as const satisfies readonly BibleVerseMessage[]`; do not regenerate, normalize, or fetch it during migration. Preserve every metadata field, including `staticEmbeddingAllowed`. State that the package MIT license covers code while the embedded WEB, BSB, ASV, DARBY, YLT, and DRA passages are public domain and OEB passages are CC0 under the recorded notices. Add the same embedded-text provenance boundary to `docs/migration-provenance.md`.

Add:

- `test/bible-verse-picker.test.ts`: exact formatting, rejection of pools at or below the recent limit, deterministic random boundaries, no repeat within 20 selections, eviction after the window, and independent picker state;
- `test/bible-translations.test.ts`: exactly 291 records with 291 unique IDs, valid nonempty fields and positive verse counts, every record referencing one of the seven metadata entries, and translation counts `ASV: 50`, `BSB: 84`, `DARBY: 14`, `DRA: 6`, `OEB: 59`, `WEB: 77`, and `YLT: 1`; require deep equality of all seven complete metadata records and every field against an explicit fixture covering `name`, `edition`, `license`, `staticEmbeddingAllowed`, `sourceUrl`, `rightsUrl`, `sourceArchiveSha256`, and `provenanceNotice`;
- `test/extension.test.ts`: reset Vitest modules, install deterministic randomness before importing the module-level picker, invoke the default factory against a recording Pi API, and assert one `turn_start` handler sets an exact formatted working message while one `turn_end` handler clears it with no argument.

The picker is intentionally module-scoped and retains its recent window across extension factory calls in one process. Preserve that state model and isolate tests with fresh module imports. The extension owns no timer, process, file, network, or cleanup resource. Before final validation, compare all four target `src/*.ts` files byte-for-byte with their mapped sources.

**Complete when:** package typechecking and all three named tests pass; Pi `0.84.1` accepts `turn_start`, `turn_end`, and `setWorkingMessage(message?)`; `src/` contains exactly the four mapped files and each matches its source; all 291 unique passages, the 20-item recent window, all seven translation records, and both lifecycle handlers are characterized; README and license distinguish package code from translation rights and retain the exact translation provenance.

### 7. Copy TPS Tracker and Git Status Widget

Map each loose file to its package's `src/index.ts` and create package manifests/configs, README, and MIT license.

Create both package `CONTEXT.md` files and add them to `CONTEXT-MAP.md` first. TPS defines **Official Output Count**, **Tokenized Output Count**, and **Estimated Output Count**. Git Status Widget defines **Worktree Snapshot** and **Widget Refresh** without redefining generic Git terms.

For TPS Tracker, document and test the precedence `official provider usage → tiktoken → four-characters-per-token estimate`. Use a recording Pi API, fake UI, fake clock, and module mocks to cover assistant-only output deltas, model-keyed tokenizer caching, optional-import rejection, per-message reset, accumulated stream time, final notification and next-run reset. Reset Vitest modules and install the `tiktoken` mock before each fresh entrypoint import so the process-scoped encoder cache cannot leak between cases. Preserve that production cache; adding encoder disposal is outside this migration.

For Git Status Widget, document `git` on `PATH`, two-second polling, refresh triggers, displayed counts, and failure-to-hidden behavior. Put a temporary fake `git` executable first on an isolated `PATH` for deterministic porcelain-v2, detached-head, failure, and polling tests. Add a temporary real Git repository smoke for branch, untracked and modified state. Preserve overlapping-poll and in-flight-process behavior.

**Complete when:** TPS succeeds with `tiktoken` available and mocked unavailable; Git tests cover detached/fallback branch, ahead/behind, conflicts, untracked, modified and clean state; neither suite reads user settings.

### 8. Add root package, load, and Git-install gates

Create `test/extension-entrypoints.test.ts` that reads root `pi.extensions`, asserts the exact ordered six paths derived from the Inputs and targets table, resolves them absolutely, and passes them to Pi's public `discoverAndLoadExtensions` with temporary empty `cwd` and `agentDir` directories. Assert six loaded extensions, zero errors, and the exact six resolved paths. Factories execute during loading and are not retained. Keep session behavior in package tests; the root smoke proves source resolution through Pi's real Jiti loader.

Create `scripts/check-package-packs.mjs`:

1. Discover the six workspace manifests rather than hard-coding a second package list.
2. From the root, run `npm pack --workspace <name> --dry-run --json --package-lock=false` and validate each returned file list.
3. Pack each workspace into a temporary directory, inspect the actual tarball's `package/package.json`, and remove the tarball afterward.
4. Assert `package.json`, README, LICENSE and `src/**` are present; assert `test/**`, `dist/**`, lockfiles, standalone configs/state, and repository machinery are absent.
5. Assert each packed manifest retains its name/version/license/metadata and `pi.extensions: ["./src/index.ts"]`, with no build/main/types/exports contract.
6. Install each tarball by itself into a fresh temporary npm project using `--legacy-peer-deps --package-lock=false`, then load its installed source entrypoint through `discoverAndLoadExtensions` from this repository's Pi runtime.

Create `scripts/check-git-install.mjs` to copy the working tree into a temporary directory while excluding VCS/dependency/output directories, run `npm install --omit=dev --package-lock=false`, and resolve every required runtime dependency from its workspace package. Accept `tiktoken` as optional. Assert the prepare lifecycle succeeds and `byterover-cli` is absent from the production install. Read the temporary root `pi.extensions` and load all six absolute entrypoints through this repository's `discoverAndLoadExtensions` with empty temporary discovery directories. Always remove the temporary tree.

**Complete when:** source entrypoints load through Pi, every dry-run file list and temporary tarball has exactly the intended classes of files, and the clean npm production install resolves package runtime dependencies.

### 9. Add legal and product documentation

Add a root MIT `LICENSE` and package-local MIT licenses, preserving the existing ByteRover notice. Create root `README.md` with:

- a six-package table and individual npm installation commands;
- whole-collection `pi install git:github.com/ian-pascoe/pi-extensions` behavior;
- exact package-filter examples using plain `packages/<dir>/src/index.ts` paths relative to repository root;
- external prerequisites (`brv`, `git`, optional `trash`, optional tokenizer fallback);
- the privileged-code security warning from Pi's package guidance;
- contributor setup and focused package commands.

Use the package glossaries created during the copy steps in README text. Add a short pointer in `AGENTS.md` only if the existing domain pointer does not already route agents through `docs/agents/domain.md`; keep that document the single process authority.

**Complete when:** every package has install/behavior/prerequisite documentation and a license; root Git filters select each extension independently; every glossary contains domain language only.

### 10. Configure independent versions and guarded release automation

Add `.changeset/config.json` with public access, `main` as base branch, empty `fixed`/`linked`, patch internal dependency updates, and no private-package versioning. Add two migration Changesets:

- patch `pi-adaptive-thinking`, yielding `0.1.2` when the version PR is applied;
- patch `pi-byterover`, yielding `0.2.5` when the version PR is applied.

The four new scoped packages receive no Changeset before their manual `0.1.0` bootstrap.

Add `docs/releases.md` as the single release procedure: Changeset policy, version PR, first manual scoped-package publication, trusted-publisher setup for all six packages, the `npm` GitHub environment, enabling publication, and recovery from a partial publish.

Create `.github/workflows/ci.yml` for pull requests, `main`, and manual dispatch. Use Node `22.19.0`, pnpm from `packageManager`, a frozen install, and the authoritative `pnpm verify` gate.

Create `.github/workflows/release.yml` with two mutually exclusive jobs on `main`/manual dispatch:

- while repository variable `NPM_PUBLISH_ENABLED` is not `true`, run full verification and Changesets Action in version-PR-only mode;
- when it is `true`, use the protected `npm` environment, `id-token: write`, npm CLI `>=11.5.1`, full verification, and Changesets Action with `pnpm publish-packages`.

Use the workflow's `GITHUB_TOKEN` for the version PR and no npm token. The unset repository variable is the migration safety gate.

Pin workflow actions to immutable revisions and annotate their release tags:

- `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1` (`v7`);
- `pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86` (`v6`);
- `actions/setup-node@820762786026740c76f36085b0efc47a31fe5020` (`v7`);
- `changesets/action@a45c4d594aa4e2c509dc14a9f2b3b67ba3780d0d` (`v1.9.0`).

The version job gets `contents: write` and `pull-requests: write`; pass `version: pnpm version-packages`, an explicit title/commit, GitHub releases, and `commitMode: github-api` to Changesets Action. The protected publish job gets `contents: write`, `pull-requests: write`, and `id-token: write`; pass the same version inputs plus `publish: pnpm publish-packages`. Keep OIDC permissions on that job only and set `NPM_CONFIG_PROVENANCE=true`. Use `version-packages: changeset version && pnpm install --lockfile-only`. Set `NO_UPDATE_NOTIFIER=1` for ByteRover tests in both workflows.

After this implementation is approved and merged, the human release sequence is:

1. From a clean verified checkout, manually publish the four scoped packages at `0.1.0` with public access and the one-time `--provenance=false` override; their later OIDC releases regain automatic provenance.
2. Configure npm Trusted Publishing for all six packages against `ian-pascoe/pi-extensions`, `release.yml`, the `npm` environment, and the publish action.
3. Set `NPM_PUBLISH_ENABLED=true`.
4. Merge/apply the version PR or manually dispatch release; CI publishes the two existing-package patches with provenance.

**Complete when:** `changeset status` reports only the two patch migrations; the unset gate can create/update a version PR but cannot publish; the enabled job contains OIDC/provenance configuration and no long-lived npm credential.

### 11. Run the final migration gate

Regenerate `pnpm-lock.yaml`, then run in order:

1. `pnpm format`
2. Re-run the byte-for-byte comparisons from Steps 5 and 6 for all 16 Minimal Subagents and four Bible Verses TypeScript files; formatting must not have changed any copied source.
3. `pnpm verify`
4. `pnpm changeset:status`
5. `git status --short`

`verify` is the authoritative gate and already includes loader, pack/install, and Git-install checks; focused scripts are diagnostic only. Compare the original repositories, loose files, and temporary Pi-settings before-state against their initial status/hashes. Confirm no package source contains `dist`, generated JavaScript/declarations, or copied local state.

**Complete when:** every command is green; the post-format 20-file integrity comparison passes; `pnpm-lock.yaml` has the root plus six workspace importers; pack and Git-install checks prove both distribution paths; expected versions/names match this plan; original sources/configuration remain unchanged; no publish command has run.

## Deferred human operations

These remain outside implementation: publishing the initial scoped packages, configuring npm Trusted Publishing, enabling the repository publish variable, changing installed Pi packages, and retiring or archiving old source locations.
