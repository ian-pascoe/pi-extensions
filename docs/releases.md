# Releases

This is the release procedure. Migration implementation publishes nothing.

## Versioning policy

- Packages version independently through Changesets; no fixed or linked group
  exists.
- `pi-adaptive-thinking` and `pi-byterover` are retired. They remain on npm only
  as deprecated historical artifacts and must not return to release automation.
- Package retirement uses no Changeset because removed workspaces cannot be
  versioned; npm deprecation is the release action.
- `@ian-pascoe/pi-minimal-subagents`,
  `@ian-pascoe/pi-bible-verses`, `@ian-pascoe/pi-tps-tracker`, and
  `@ian-pascoe/pi-git-status-widget`, `@ian-pascoe/pi-git-checkpoints`,
  `@ian-pascoe/pi-formatter`, `@ian-pascoe/pi-lsp`, `@ian-pascoe/pi-dap`,
  `@ian-pascoe/pi-codemode`, `@ian-pascoe/pi-mcp`, `@ian-pascoe/pi-todo`,
  and `@ian-pascoe/pi-utils` bootstrap manually at `0.1.0`;
  `@ian-pascoe/pi-web-tools` bootstraps manually at `0.0.0`. Do not add
  bootstrap Changesets.
- Use `pnpm changeset` for releasable changes and inspect them with
  `pnpm changeset:status`. The workflow creates version PRs with
  `pnpm version-packages`.

## Pre-publish checks

```bash
pnpm install --frozen-lockfile
pnpm verify
pnpm pack:check
pnpm git-install:check
pnpm changeset:status
```

The release workflow runs `pnpm verify`, the package-tarball check, and the
Git-install check in parallel. All three must pass before a version PR or
publish.

## Initial scoped-package bootstrap

After approval and merge, a human publishes twelve scoped packages at `0.1.0` and
`@ian-pascoe/pi-web-tools` at `0.0.0` from each package directory:

```bash
npm publish --access public --provenance=false
```

Publish only `@ian-pascoe/pi-minimal-subagents`,
`@ian-pascoe/pi-bible-verses`, `@ian-pascoe/pi-tps-tracker`, and
`@ian-pascoe/pi-git-status-widget`, `@ian-pascoe/pi-git-checkpoints`,
`@ian-pascoe/pi-formatter`, `@ian-pascoe/pi-lsp`, `@ian-pascoe/pi-dap`,
`@ian-pascoe/pi-codemode`, `@ian-pascoe/pi-mcp`, `@ian-pascoe/pi-todo`, and
`@ian-pascoe/pi-web-tools`. Verify Web Tools is `0.0.0` and every other package
is `0.1.0`, plus each name and tarball, before publishing. This is
the one-time provenance exception; later releases use OIDC.

## Trusted publishing and guarded automation

Configure npm Trusted Publishing for all thirteen active packages with repository
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
