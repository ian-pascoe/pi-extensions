# Pi Tool Installer

Shared compiled library for private Managed Installations. It is not a Pi extension
and does not register tools, read Pi settings, or choose language presets.

**Work in progress:** LSP, DAP, and Formatter do not use this library yet. The
[six-platform acquisition and launch gate](../../docs/plans/managed-language-tools.md)
has not passed. Do not infer platform support from a successful version lookup.
In particular, mise's pipx backend rewrites Python interpreter links to moving
minor-version aliases; preserving concrete Python runtimes across updates still
needs a verified solution.

## API

```ts
import { ToolInstaller } from "@ian-pascoe/pi-tool-installer";

const installer = new ToolInstaller(privateStoreDirectory);
const request = { id: "node", requirements: { runtime: "core:node" } };
const installation = await installer.ensure(request, {
  allowDownload: true,
  signal,
  onProgress: (message) => console.log(message),
});
```

- `installed(id)` reads an existing selection without running a helper or accessing
  the network. Missing selections return `undefined`.
- `ensure(request, options)` reuses that selection, or acquires the latest concrete
  versions when downloads are allowed. Requirements are processed in insertion
  order so a runtime can precede a tool that needs it.
- `update(request, options)` deliberately resolves latest versions for an existing
  selection. It returns `{ previous, current }`, or `undefined` for an unused ID.
  It does not install unused presets as a side effect.

Results contain concrete component versions and installation directories,
`binDirectories`, and child-process `environment` additions without PATH. Callers
own executable paths, arguments, runtime selection, Pi settings, and progress UI.
Use reviewed, package-owned acquisition selectors; never accept workspace recipes.

## Isolation and durability

The helper runs in a private working directory with no mise configuration or hooks,
a private HOME and data/cache/config/temp directories, and a system-only PATH.
Acquisition changes neither the calling process environment nor shell startup files.
A heartbeat lock coordinates Pi processes sharing a store. Selection records are
published by rename only after all components install; failed or cancelled updates
leave the prior selection intact. Existing concrete versions are retained.

The first acquisition downloads a native mise release binary and verifies its
GitHub-published SHA-256 digest. Component acquisition and archive extraction are
delegated to mise's backends. This is not a claim of independently verified
provenance for every backend or reproducible transitive dependencies.

Cancellation stops the acquisition process tree. Installed-only resolution does
not download the helper; explicit updates remain deliberate network actions.

## Verification

Routine tests are offline:

```sh
pnpm --dir packages/pi-tool-installer test
```

Real downloads and native launches require an explicit opt-in:

```sh
PI_TOOL_INSTALLER_NATIVE=1 pnpm --dir packages/pi-tool-installer exec vitest run --config ../../vitest.config.ts --root . native.test.ts
```

The CI workflow's `native_only=true` manual dispatch runs these probes on native
Linux, macOS, and Windows x64 and ARM64 runners. Missing upstream artifacts are
failures, not permission to downgrade or omit a platform.
