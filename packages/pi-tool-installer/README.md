# Pi Tool Installer

Shared compiled library for private Managed Installations. It is not a Pi extension
and does not register tools, read Pi settings, or choose language presets.

**Work in progress:** LSP, DAP, and Formatter do not use this library yet. The
[six-platform acquisition and launch gate](https://github.com/ian-pascoe/pi-extensions/actions/runs/34520581283)
passed at `59c17f0`: 11 native checks per target, 66 total. This proves acquisition
and launch, not the complete installation/update or extension integration contract.
In particular, mise's pipx backend rewrites Python interpreter links to moving
minor-version aliases. A separate Linux experiment verified dependency-specific
pipx namespaces with shared, concrete Python runtimes; that solution still needs
integration and public update/cancellation regression tests.

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
An optional `GITHUB_TOKEN` authenticates only the helper's GitHub API metadata
request, avoiding shared-IP API limits. It is not forwarded to artifact downloads
or mise subprocesses; metadata redirects are rejected rather than forwarding it.

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

### Initial verified baselines

The initial minimum **verified** OS/runtime baselines are below. Older releases,
other Linux distributions, musl, and emulated architectures are not covered by this
evidence. Host tests use Node 22.19.0 and Pi 0.85.1; the privately acquired Node
runtime is separate from the host runtime.

| Native target | Verified OS baseline               | Result    |
| ------------- | ---------------------------------- | --------- |
| Linux x64     | Ubuntu 24.04.5 LTS                 | 11 passed |
| Linux ARM64   | Ubuntu 24.04.5 LTS                 | 11 passed |
| macOS x64     | macOS 15.7.9, build 24G830         | 11 passed |
| macOS ARM64   | macOS 15.7.9, build 24G830         | 11 passed |
| Windows x64   | Windows Server 2025, build 26100   | 11 passed |
| Windows ARM64 | Windows 11 Enterprise, build 26200 | 11 passed |

All six jobs resolved the same concrete versions on 2026-09-10. These are evidence,
not release pins; new installations and explicit updates still resolve upstream.

| Component             | Verified version |
| --------------------- | ---------------- |
| Node                  | 26.8.2           |
| Python                | 3.14.7           |
| uv                    | 0.12.12          |
| TypeScript native LSP | 7.0.2            |
| Pyright               | 1.1.413          |
| Prettier              | 3.9.6            |
| Biome                 | 2.5.12           |
| Black                 | 26.5.1           |
| Ruff                  | 0.16.6           |
| Go / gofmt            | 1.27.1           |
| gopls                 | 0.23.0           |
| Rust / rustfmt        | 1.98.1           |
| rust-analyzer         | 2026-09-07       |
| vscode-js-debug       | 1.117.0          |
| debugpy               | 1.8.21           |

The probes include TypeScript and JavaScript document-symbol requests, Python/Go/
Rust LSP requests, formatter output, and JavaScript/Python debugging with
breakpoints, stack inspection, continuation, and stop. Installation and project
paths contain spaces and Unicode. Windows workspace paths are canonicalized for
gopls; macOS debugger IPC uses a separate short private temporary directory.
GitHub shared-IP rate limits can still prevent mise backend downloads: the optional
helper metadata token does not authenticate those subprocesses.

Separate-process concurrency, interruption during an actual install, immutable
Python updates, package precedence, and offline SDK prefix/coexistence proofs
remain later gates; the bootstrap probe's two installer instances are not separate
Pi processes.
