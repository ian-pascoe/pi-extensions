# Pi Tool Installer

Shared compiled library for private Managed Installations. It is not a Pi extension
and does not register tools, read Pi settings, or choose language presets.

LSP, DAP, and Formatter use this library for first-use acquisition and updates. The
[full verification gate](https://github.com/ian-pascoe/pi-extensions/actions/runs/34545535384)
passed at source commit `2398fc42e4a704e8573a900ae1eb57e630a96364` on 2026-09-11:
12 native checks per target, 72 total, across native Linux/macOS/Windows x64 and
ARM64. These cover acquisition, launch, immutable Python updates, real-install
cancellation/failure/retry, and separate-process coordination/interruption.
All six targets also passed 15 offline installer and 110 extension checks each;
repository verification, tarball validation, and clean Git-install validation passed.

The initial [acquisition/launch gate](https://github.com/ian-pascoe/pi-extensions/actions/runs/34520581283)
at `59c17f0` passed the original 11 native checks per target on 2026-09-10.
The final run retains those checks and adds the hardened update/integration proofs.

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
  the network. Missing selections or directories return `undefined`; malformed
  metadata and paths escaping the store are rejected.
- `ensure(request, options)` reuses matching ordered requirement identities. It can
  adopt an existing selection's complete graph or proven ordered prefix under a
  different ID, remapping component names without running the helper. For example,
  Formatter can reuse a Go/Rust toolchain acquired for LSP. Only requested components
  and their original execution context enter the new selection; prerequisite graphs
  are never stitched together. When downloads are allowed, changed requirements
  resolve only new/changed selectors and retain unchanged selectors' concrete versions.
  Missing directories can be reacquired at their recorded versions. Installed-only
  Mode reports unavailability without bootstrapping the helper. Requirements are
  processed in insertion order so a runtime precedes its tool.
- `update(request, options)` deliberately resolves latest versions for an existing
  selection. It returns `{ previous, current }`, or `undefined` for an unused ID.
  It does not install unused presets as a side effect.

Results contain each component's `selector`, concrete `version`, and installation `directory`,
`binDirectories`, and child-process `environment` additions without PATH. Callers
own executable paths, arguments, runtime selection, Pi settings, and progress UI.
Use reviewed, package-owned acquisition selectors; never accept workspace recipes.
Native mise ToolArgs with a trailing version/prefix (including scoped npm packages)
are supported without double-appending versions. Language Tool Presets must still
use latest selectors; the native update fixture uses explicit versions solely to
control its old/new runtime comparison. Earlier unreleased prototype records without
selector identity are rejected rather than guessed.

## Isolation and durability

The helper runs in a private working directory with no mise configuration or hooks,
a private HOME and data/cache/config/temp directories, and a system-only PATH.
Acquisition changes neither the calling process environment nor shell startup files.
A heartbeat lock coordinates Pi processes sharing a store. Selection records are
published by rename only after all components install and their directories validate;
failed or cancelled updates leave the prior selection intact. Existing concrete
versions are retained. Missing directories are distinct from corrupt metadata.

Selection records keep an optional private `contexts` array: each entry records the
native executable directories and environment after the corresponding ordered
acquisition step. Prefix reuse uses that exact context, not a trailing tool's settings
or guessed filesystem layouts. These snapshots are not added to public API results.
Earlier pre-release records without snapshots remain usable by their original ID or
as complete graphs. Shorter-prefix adoption needs a deliberate `update` to refresh
that metadata; Installed-only Mode never performs that network action implicitly.

Only pipx installations get a namespace keyed by the concrete tool and preceding
dependency graph. Its mise data, system-data, and cache directories are scoped.
Python is reused through a native `@path:` ToolArg; UV is resolved from the already
prefixed private child PATH. Both remain in the namespace identity. Passing Aqua
UV as an `@path:` ToolArg can crash mise's Windows executable/version resolution,
so it is not repeated in the scoped toolset.
An exact `UV_PYTHON` selects the shared full-patch interpreter outside that namespace,
so mise does not rewrite its venv links to moving minor-version aliases. No runtime
copies or hand-edited links are involved. Python downloads, uv configuration, and
bytecode writes are disabled for this composition.

Mise retains ownership of component install locks and incomplete markers. The store
heartbeat lock coordinates selection publication; a dead owner's lock expires.
A hard-killed Pi process can leave mise finishing an unselected concrete install;
retry uses mise's component lock/completion checks before publishing a selection.

The first acquisition downloads a native mise release binary and verifies its
GitHub-published SHA-256 digest. Component acquisition and archive extraction are
delegated to mise's backends. This is not a claim of independently verified
provenance for every backend or reproducible transitive dependencies.
An optional `GITHUB_TOKEN` authenticates only the helper's GitHub API metadata
request, avoiding shared-IP API limits. It is not forwarded to artifact downloads
or mise subprocesses; metadata redirects are rejected rather than forwarding it.

Cancellation stops the acquisition process tree. Progress includes native helper
stderr lines, allowing cancellation during actual downloads rather than only version
resolution. Installed-only resolution does not download the helper; explicit updates
remain deliberate network actions.

## Verification

Routine tests are offline:

```sh
pnpm --dir packages/pi-tool-installer test
```

Real downloads and native launches require an explicit opt-in:

```sh
pnpm --dir packages/pi-tool-installer build
PI_TOOL_INSTALLER_NATIVE=1 pnpm --dir packages/pi-tool-installer exec vitest run --config ../../vitest.config.ts --root . --maxWorkers=1 native.test.ts
```

The CI workflow's `native_only=true` manual dispatch runs these probes on native
Linux, macOS, and Windows x64 and ARM64 runners. Missing upstream artifacts are
failures, not permission to downgrade or omit a platform.

### Verified baselines

The minimum **verified** OS/runtime baselines are below. Older releases,
other Linux distributions, musl, and emulated architectures are not covered by this
evidence. Host tests use Node 22.19.0 and Pi 0.85.1; the privately acquired Node
runtime is separate from the host runtime.

| Native target | Verified OS baseline               | Result    |
| ------------- | ---------------------------------- | --------- |
| Linux x64     | Ubuntu 24.04.5 LTS                 | 12 passed |
| Linux ARM64   | Ubuntu 24.04.5 LTS                 | 12 passed |
| macOS x64     | macOS 15.7.9, build 24G830         | 12 passed |
| macOS ARM64   | macOS 15.7.9, build 24G830         | 12 passed |
| Windows x64   | Windows Server 2025, build 26100   | 12 passed |
| Windows ARM64 | Windows 11 Enterprise, build 26200 | 12 passed |

All six successful jobs resolved the same concrete versions on 2026-09-11. These are evidence,
not release pins; new installations and explicit updates still resolve upstream.

| Component               | Verified version |
| ----------------------- | ---------------- |
| Installer Helper (mise) | 2026.9.5         |
| Node                    | 26.8.2           |
| Python                  | 3.14.7           |
| uv                      | 0.12.12          |
| TypeScript native LSP   | 7.0.2            |
| Pyright                 | 1.1.414          |
| Prettier                | 3.9.6            |
| Biome                   | 2.5.12           |
| Black                   | 26.5.1           |
| Ruff                    | 0.16.6           |
| Go / gofmt              | 1.27.1           |
| gopls                   | 0.23.0           |
| Rust / rustfmt          | 1.98.1           |
| rust-analyzer           | 2026-09-07       |
| vscode-js-debug         | 1.117.0          |
| debugpy                 | 1.8.21           |

The probes include TypeScript and JavaScript document-symbol requests, Python/Go/
Rust LSP requests, formatter output, and JavaScript/Python debugging with
breakpoints, stack inspection, continuation, and stop. Installation and project
paths contain spaces and Unicode. Windows workspace paths are canonicalized for
gopls; macOS debugger IPC uses a separate short private temporary directory.
GitHub shared-IP rate limits can still prevent mise backend downloads: the optional
helper metadata token does not authenticate those subprocesses.

The suite retains all 11 original catalog/bootstrap checks and adds a native Python
update regression (12 checks per target). The bootstrap check now launches two
separate Node processes. The Python check keeps Black 26.5.1 while changing Python
3.14.6 → 3.14.7, verifies old/new formatting and full-patch runtime identity, checks
unchanged old runtime metadata and absence of namespace runtime copies, then tests
native install failure, cancellation on UV's Black installation progress, hard process
death, and retry/offline reuse. The trigger uses dependency-resolution output because
small wheels can omit download status lines. Fifteen routine tests cover the public
installer API offline, replacing only external download/process boundaries. The pipx
regression also verifies that updating shared UV changes the environment identity
without copying Python or dropping the private UV executable path. Cross-ID reuse
checks preserve the donor selection, exclude trailing-tool environment changes,
retain existing runtime versions, and reject incompatible graphs or corrupt context.
The native Go/Rust probes execute their formatters through separately selected,
installed-only toolchain prefixes.

The final gate passed all nine jobs across attempts 1 and 2 at the same source
commit. Attempt 1 passed eight jobs; Windows ARM's Go archive transfer stalled after
upstream response-body errors and hit the five-minute acquisition deadline. Attempt 2
reran only Windows ARM and passed all 27 installer and 110 extension checks, retaining
the other eight successes. Earlier upstream HTTP failures and shared-IP rate limits
were not suppressed or worked around by forwarding credentials to mise.

CI serializes package jobs and native test files to avoid competing worker pools,
without serializing the explicit concurrent-acquisition scenarios inside tests.
The extension checks cover precedence, cancellation, updates, and coexistence;
offline SDK tests compare ordered serialized tool definitions, system prompts, and
history across actual root/child sessions. The final Pyright version above supersedes
1.1.413 from the initial acquisition gate; versions remain evidence, not release pins.
