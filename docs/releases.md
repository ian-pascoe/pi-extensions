# Releases

This is the release procedure. Migration implementation publishes nothing.

## Versioning policy

- Packages version independently through Changesets; no fixed or linked group
  exists.
- Every `@ian-pascoe/pi-utils` release patch-bumps each consumer and raises its
  range to the new version, because the package-tarball check requires every
  consumer's packed range to name the workspace pi-utils version. Changesets
  otherwise leaves an in-range consumer unreleased. The Changesets config sets
  `___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH.updateInternalDependents`
  to `always` for this; recheck the option name when upgrading Changesets.
- `pi-adaptive-thinking`, `pi-byterover`, `@ian-pascoe/pi-codemode`,
  `@ian-pascoe/pi-mcp`, and `@ian-pascoe/pi-git-status-widget` are retired. They remain on npm only as deprecated
  historical artifacts and must not return to release automation.
- Package retirement uses no Changeset because removed workspaces cannot be
  versioned; npm deprecation is the release action.
- `@ian-pascoe/pi-minimal-subagents`,
  `@ian-pascoe/pi-bible-verses`, `@ian-pascoe/pi-tps-tracker`, and
  `@ian-pascoe/pi-git-status-widget`, `@ian-pascoe/pi-git-checkpoints`,
  `@ian-pascoe/pi-formatter`, `@ian-pascoe/pi-lsp`, `@ian-pascoe/pi-dap`,
  `@ian-pascoe/pi-codemode`, `@ian-pascoe/pi-mcp`,
  and `@ian-pascoe/pi-utils` bootstrap manually at `0.1.0`;
  `@ian-pascoe/pi-todo`, `@ian-pascoe/pi-web-tools`, `@ian-pascoe/pi-termctrl`, and
  `@ian-pascoe/pi-command-deck` bootstrap manually at `0.0.0`. The manual
  bootstrap publish needs no Changeset, but the implementation PR still adds a
  `minor` Changeset for the new package; its version PR releases `0.1.0`
  through the trusted-publishing workflow.
- Use `bun run changeset` for releasable changes and inspect them with
  `bun run changeset:status`. The workflow creates version PRs with
  `bun run version-packages`.
- Bun installs and runs scripts, but releases publish with npm: Changesets calls
  `npm publish` with provenance, and `bun publish` is never used. npm and Bun ignore
  `publishConfig` field overrides, so `@ian-pascoe/pi-utils` (whose workspace manifest
  points `exports` at `src`) publishes only through `bun run publish-packages`, which
  first runs `node scripts/publish-manifest.mjs apply` to lift its `dist` entrypoints to
  the top level. Its `prepack` runs `check` and fails an unapplied manifest, so a bare
  `npm publish` cannot ship a package whose `exports` point at `src`. After a release,
  confirm the registry metadata with `npm view @ian-pascoe/pi-utils exports`: every
  entry must name `dist`.

## Pre-publish checks

```bash
bun install --frozen-lockfile
bun run verify
bun run pack:check
bun run git-install:check
bun run changeset:status
```

The release workflow runs `bun run verify`, the package-tarball check, and the
Git-install check in parallel. All three must pass before a version PR or
publish.

## Initial scoped-package bootstrap

After approval and merge, bootstrap eleven scoped packages at `0.1.0` and
`@ian-pascoe/pi-todo`, `@ian-pascoe/pi-web-tools`, and `@ian-pascoe/pi-termctrl` at `0.0.0`
from each package directory:

```bash
npm publish --access public --provenance=false
```

Publish only `@ian-pascoe/pi-minimal-subagents`,
`@ian-pascoe/pi-bible-verses`, `@ian-pascoe/pi-tps-tracker`, and
`@ian-pascoe/pi-git-status-widget`, `@ian-pascoe/pi-git-checkpoints`,
`@ian-pascoe/pi-formatter`, `@ian-pascoe/pi-lsp`, `@ian-pascoe/pi-dap`,
`@ian-pascoe/pi-codemode`, `@ian-pascoe/pi-mcp`, `@ian-pascoe/pi-todo`,
`@ian-pascoe/pi-web-tools`, and `@ian-pascoe/pi-termctrl`. Verify Todo, Web Tools, and
Termctrl are `0.0.0` and every other package
is `0.1.0`, plus each name and tarball, before publishing. This is
the one-time provenance exception; later releases use OIDC.

## Advisor bootstrap

Advisor starts at `0.0.0` after its approved implementation PR merges. It requires
`pi-utils@0.2.0` for the native-session discovery export; its dependency range must
start at `^0.2.0`. The utility release is recorded in its manifest and changelog,
consuming its Changeset entry rather than scheduling another minor bump.

1. For this explicitly approved bootstrap only, manually publish
   `@ian-pascoe/pi-utils@0.2.0` from `packages/pi-utils` after the release gates pass.
   From the repository root, run `node scripts/publish-manifest.mjs apply packages/pi-utils`
   first, because `prepack` rejects an unapplied manifest, then `npm publish --access public
   --provenance=false` from `packages/pi-utils`, and finally
   `node scripts/publish-manifest.mjs restore packages/pi-utils` from the root to put the
   workspace manifest back.
2. Verify that registry version and its discovery export, then publish Advisor
   from `packages/pi-advisor` with the same command. These publications use an
   approved one-time provenance exception; subsequent releases use OIDC.
3. Configure Advisor's trusted publisher with repository
   `ian-pascoe/pi-extensions`, workflow `release.yml`, environment `npm`, and
   publish permission. Verify a clean registry installation.

Leave any generated version PR unmerged during bootstrap; later releases use the
ordinary Changesets/OIDC workflow. No release workflow changes are required.

## Command Deck bootstrap and Git Status Widget retirement

After the implementation PR merges, publish `@ian-pascoe/pi-command-deck@0.0.0`
from `packages/pi-command-deck` with `npm publish --access public --provenance=false`,
then configure its trusted publisher as for Advisor. Its `minor` Changeset then
releases `0.1.0` through the ordinary version PR. Deprecate every published
`@ian-pascoe/pi-git-status-widget` version:

```bash
npm deprecate @ian-pascoe/pi-git-status-widget "Retired; use @ian-pascoe/pi-command-deck."
```

## Guardian bootstrap

After the implementation PR merges, publish `@ian-pascoe/pi-guardian@0.0.0`
from `packages/pi-guardian` with `npm publish --access public --provenance=false`
after the release gates pass, then configure its trusted publisher as for Advisor.
The `0.0.0` bootstrap only reserves the package name and cannot load: Guardian
imports the `layered-settings` and `evidence` exports that the pending
`@ian-pascoe/pi-utils` minor release adds, while its manifest range still names
the current pi-utils version. The range cannot be raised first, because the
package-tarball check requires every consumer's packed range to name the
workspace pi-utils version. Guardian's `minor` Changeset releases the usable
`0.1.0` in the same version PR that releases pi-utils and raises Guardian's
pi-utils range. Once `0.1.0` is published, deprecate the placeholder:

```bash
npm deprecate @ian-pascoe/pi-guardian@0.0.0 "Name reservation only; it cannot load. Install 0.1.0 or later."
```

## Pi Secret bootstrap

Bootstrap `@ian-pascoe/pi-secret` the same way as Guardian: after the
implementation PR merges, publish `@ian-pascoe/pi-secret@0.0.0` from
`packages/pi-secret` with `npm publish --access public --provenance=false` after
the release gates pass, and configure its trusted publisher. The placeholder
cannot load, because it imports the `secret-registry` export that the pending
`@ian-pascoe/pi-utils` minor release adds. Its `minor` Changeset releases the
usable `0.1.0` in the version PR that releases pi-utils. Then deprecate the
placeholder:

```bash
npm deprecate @ian-pascoe/pi-secret@0.0.0 "Name reservation only; it cannot load. Install 0.1.0 or later."
```

## Trusted publishing and guarded automation

Configure npm Trusted Publishing for every active package with repository
`ian-pascoe/pi-extensions`, workflow `.github/workflows/release.yml`, and
protected GitHub environment `npm`. Then set repository variable
`NPM_PUBLISH_ENABLED=true`.

Until that variable is exactly `true`, the release workflow can verify and
create/update a version PR but must not publish. The publish job runs only in
the protected `npm` environment, receives `id-token: write`, sets
`NPM_CONFIG_PROVENANCE=true`, and never uses a long-lived npm token.

## Routine release

1. Merge a reviewed Changeset to `main`.
2. Review and merge the workflow's version PR.
3. Run the guarded release workflow on `main`, or use its guarded dispatch.
4. Confirm npm versions, provenance attestations, GitHub releases, and npm
   installation.

## Partial-publish recovery

1. Stop publishing and record package names and versions.
2. Never retry a published version; npm versions are immutable.
3. Inspect npm, workflow logs, and the version PR for packages that failed.
4. Add a Changeset for only the unpublished or corrective packages, rerun the
   full checks, and release new versions through the guarded workflow.
5. Record user-facing recovery guidance in the relevant changelog or release.
