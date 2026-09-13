# DAP preset candidates

Research date: 2026-09-11. This is a design input, not an implementation or a
platform-support claim. The installer must work on native Linux/macOS/Windows x64
and ARM64, but presets may support a verified subset under
[ADR-0006](../adr/0006-separate-installer-and-preset-platform-support.md). Each claimed
platform still requires acquisition, launch, cancellation, and lifecycle evidence.
OpenCode has no DAP catalog; these candidates were evaluated from their own repositories.

## Catalog decision

The user selected **Deno JavaScript/TypeScript through the existing JavaScript
adapter, Delve for Go, CodeLLDB for Rust/C++, and NetCoreDbg for .NET**, retaining
existing JavaScript/Python support. The compiled-language additions use explicit
compiled-program/assembly profiles, not inferred project builds. The
[design plan](../plans/language-tool-preset-expansion.md) records the accepted
2026-09-12 additions. All selected tools ship together after their declared platform
gates pass; no staged/cohort release is approved. Earlier six-cell comparisons
remain useful facts, but a missing platform no longer excludes the whole preset.
LLVM lldb-dap remains an unselected alternative, not an extra catalog obligation.

- **Delve (`dlv dap`) for Go:** plausible, but release-tag Windows ARM64 support is
  explicitly experimental, and macOS requires a debugserver in addition to Go.
- **CodeLLDB for Rust/C++:** selected; its missing release cell is Windows ARM64.
  LLVM lldb-dap has different gaps but is not needed merely to force platform parity.
- **NetCoreDbg for .NET:** selected with platform and runtime verification still
  outstanding. No newly selected adapter has completed its Pi proof obligations.

## Delve

**Language and launch boundary.** Delve is a Go debugger. Its official `dlv dap`
command starts a headless TCP DAP server. The documented launch modes include
`exec` (precompiled binary), `debug` (build and launch), `test`, `replay`, and
`core`; it also supports attach. A first Pi preset should expose only a direct
precompiled executable (`mode: exec`) and explicit `program`, `args`, and `cwd`.
It should not silently run `go build`, `go test`, attach, replay, or core-dump
workflows. Those need explicit Launch Profiles and potentially additional Pi
DAP semantics.

**Protocol fit.** `dlv dap` listens on `127.0.0.1:0` by default and accepts one
client. Pi DAP already owns a single active session and supports TCP adapters,
so the basic transport is a plausible fit. Delve's own source documents the DAP
server as single-client/single-session and currently synchronous request/response;
the candidate must be tested against Pi's initialization, breakpoints, stack,
variables, evaluate, continue, stop, and shutdown sequence. Its `--client-addr`
reverse-connect mode is not needed for the initial profile.

**Runtime and acquisition.** Delve's `go.mod` currently declares Go 1.25.0;
the current Pi Go runtime baseline is newer (1.27.1 in the verified managed
matrix). Official installation supports `go install github.com/go-delve/delve/cmd/dlv@...`
and also publishes release archives. The installer identity and archive extraction
mapping are not yet proven in `pi-tool-installer`; do not assume that a generic
`go:` or GitHub selector is sufficient. A source-built `dlv` using the existing
private Go toolchain is a possible **experimental** Windows ARM64 path (see the
release-tag correction below), not an ordinary supported `go install` recipe.
Build and module caches must remain private. Go alone is insufficient on macOS.

**Release assets / Windows ARM64.** Latest upstream release observed: `v1.27.2`,
published 2026-09-09. Its release API lists `darwin_amd64`, `darwin_arm64`,
`linux_amd64`, `linux_arm64`, and `windows_amd64` archives (plus checksums and
signatures); there is no Windows ARM64 archive. The same **release tag**, not merely HEAD, contains the
Windows ARM64 workflow testing Go 1.26, 1.27, and tip. However,
`support_sentinel_windows.go` rejects ARM64 unless `exp.winarm64` is enabled;
`_scripts/make.go` adds that tag for tests, and `.goreleaser.yaml` explicitly
excludes Windows ARM64 because it is “not yet stable.” Architecture-specific
register/thread/syscall code exists in the tag. Thus source is available, but
plain `go install ...@v1.27.2` is not a viable Windows ARM64 recipe; an experimental
`-tags=exp.winarm64` build is only an unverified candidate, not stable support.
The native test script also acquires llvm-mingw for its CGo test environment;
that is not proof that a pure-Go adapter build itself requires a C compiler.
The release documentation recommends cosign verification of the signed checksum
file and checksum validation.

**macOS prerequisite correction (both architectures).** Tagged installation docs
require Command Line Developer Tools and describe debugger authorization prompts;
`DevToolsSecurity` and developer-group changes are optional ways to reduce those
prompts, not actions Pi may silently perform. The default backend in
`service/debugger/debugger.go` is LLDB on Darwin. `gdbserial/gdbserver.go` looks for
Apple's `debugserver` on PATH or in CLT/Xcode, or accepts
`DELVE_DEBUGSERVER_PATH`; release archives do not solve that dependency. The
release recipe cross-compiles Darwin in pure Go and signs checksums with cosign,
which is **not** macOS debugger code signing/entitlement evidence. Ordinary
source installation has the same backend dependency. The optional macnative
backend is x64-only in `_scripts/make.go`, requires CGo/SDK headers and certificate
setup, and is documented as unnecessary and problematic; it is not a six-cell
escape hatch. A privately supplied, correctly signed/entitled debugserver remains
to be proven on clean Macs without asking users to install CLT or modify system
security. LLVM's macOS debugserver entitlement is cited in the LLVM section.

**License and provenance.** Delve is MIT-licensed and its release provides
checksums plus a signed checksum certificate/signature. These are favorable for
redistribution, subject to the installer/library's existing artifact-verification
limits.

Sources:

- DAP command and launch modes: <https://raw.githubusercontent.com/go-delve/delve/master/Documentation/usage/dlv_dap.md>
- DAP implementation and single-client/synchronous-session comments:
  <https://raw.githubusercontent.com/go-delve/delve/master/service/dap/server.go>
- Installation, source-build fallback, and cosign/checksum instructions:
  <https://raw.githubusercontent.com/go-delve/delve/master/Documentation/installation/README.md>
- Current module Go requirement: <https://raw.githubusercontent.com/go-delve/delve/master/go.mod>
- `v1.27.2` release and exact asset list/digests:
  <https://api.github.com/repos/go-delve/delve/releases/latest>
- Windows ARM64 source test workflow:
  <https://raw.githubusercontent.com/go-delve/delve/master/.github/workflows/test-windows-arm64.yml>
- MIT license: <https://raw.githubusercontent.com/go-delve/delve/master/LICENSE>

Release-tag follow-up sources (supersede HEAD-only acquisition inference):

- [Release assets](https://api.github.com/repos/go-delve/delve/releases/tags/v1.27.2),
  [release recipe](https://github.com/go-delve/delve/blob/v1.27.2/.goreleaser.yaml),
  [Windows support sentinel](https://github.com/go-delve/delve/blob/v1.27.2/pkg/proc/native/support_sentinel_windows.go).
- [ARM64 threads](https://github.com/go-delve/delve/blob/v1.27.2/pkg/proc/native/threads_windows_arm64.go),
  [ARM64 syscalls](https://github.com/go-delve/delve/blob/v1.27.2/pkg/proc/native/syscall_windows_arm64.go),
  [tagged workflow](https://github.com/go-delve/delve/blob/v1.27.2/.github/workflows/test-windows-arm64.yml),
  [test setup](https://github.com/go-delve/delve/blob/v1.27.2/_scripts/test_windows.ps1),
  [build/test tags and macnative checks](https://github.com/go-delve/delve/blob/v1.27.2/_scripts/make.go).
- [Installation/macOS prerequisites](https://github.com/go-delve/delve/blob/v1.27.2/Documentation/installation/README.md),
  [default backend](https://github.com/go-delve/delve/blob/v1.27.2/service/debugger/debugger.go),
  [debugserver selection/override](https://github.com/go-delve/delve/blob/v1.27.2/pkg/proc/gdbserial/gdbserver.go).

## LLVM `lldb-dap` alternative

**Fit.** This is LLVM's own LLDB-backed DAP executable, not CodeLLDB and not an
editor extension requirement. Upstream documents a direct compiled `program`,
`args`, and `cwd` launch. It is a credible C/C++ candidate and a Rust comparison
candidate, not evidence of CodeLLDB-equivalent Rust expression evaluation or
pretty-printing. Rust symbols, variables, expression behavior, and required
language scripts still need explicit checks; no Cargo/project build is implied.

**Current distribution: `llvmorg-23.1.1`, published 2026-09-08.** The exact release
API and tagged build recipe show the following paths. Archive presence and build
configuration are evidence, **not** archive-content inspection or native DAP tests.

| Native cell   | Official release archive / source path                                                   | Remaining private-acquisition evidence                                                                   |
| ------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Linux x64     | `LLVM-23.1.1-Linux-X64.tar.xz`                                                           | LLDB/library/Python closure and compatible system ABI; upstream builds on Ubuntu 22.04.                  |
| Linux ARM64   | `LLVM-23.1.1-Linux-ARM64.tar.xz`                                                         | Same; native ARM runner/build exists.                                                                    |
| macOS x64     | **No archive in this release**; upstream CMake source build for x86_64 remains possible. | Private build toolchain/Apple SDK plus usable signed debugserver; no clean-machine recipe proven.        |
| macOS ARM64   | `LLVM-23.1.1-macOS-ARM64.tar.xz`                                                         | Relocatable dependencies, minimum OS and signed/entitled debugserver usable without CLT/Xcode.           |
| Windows x64   | `clang+llvm-23.1.1-x86_64-pc-windows-msvc.tar.xz`                                        | DLL/Python/PDB dependencies and native launch. Prefer archive extraction over system MSI installation.   |
| Windows ARM64 | `clang+llvm-23.1.1-aarch64-pc-windows-msvc.tar.xz`                                       | Same; tagged Windows release script explicitly builds LLDB for ARM64, but `check-lldb` is commented out. |

The release also offers equivalent `.tar.zst` archives and attestations. The xz
payloads are roughly 0.76–2.01 GB: private extraction is plausible but considerably
heavier than acquiring an adapter alone. Its macOS x64 release link is commented
out, not a downloadable sixth cell. **No current binary is not the same as no
viable source build**: LLVM retains macOS x64 debugserver source and general LLDB
build instructions; the unproven part is satisfying Pi's private/no-manual-SDK
contract, not a demonstrated architecture impossibility.

**Runtime/build boundary.** The `lldb-dap` target links `liblldb` and LLDB host
support; retain the matching libraries and platform helper (`lldb-server` on
Linux, `debugserver` on macOS), rather than copying one executable. Python is an
optional LLDB build feature, not intrinsic to DAP; Python-enabled distributions
need a compatible runtime/module search path. The tagged Windows release recipe
sets `LLDB_RELOCATABLE_PYTHON=1` and `LLDB_EMBED_PYTHON_HOME=OFF`; its workflow uses
Python 3.14.6. This improves relocation prospects, but does not prove the archive
bundles all Python/VC runtime DLLs or works with Pi's private Python. Exact loader
closure, native Windows ARM64 debugging/PDB handling, and Rust script needs remain
unknown without artifact inspection and native probes.

Source builds need LLVM and Clang, CMake/Ninja and a C/C++ toolchain; optional
Python scripting adds Python and SWIG. Windows upstream instructions require
Visual Studio C++/Windows SDK/ATL and describe privileged DIA registration. Those
are **build instructions**, not proof a prebuilt DAP runtime needs Visual Studio;
copying them would violate private acquisition. On macOS, debugserver generation
uses the Apple SDK and `mig`; upstream signing instructions set up a certificate
and require authorization. `LLDB_USE_SYSTEM_DEBUGSERVER=ON` avoids building/signing
a helper only by depending on an existing system helper, so is not clean-Mac
private-acquisition proof. The public macOS debugserver entitlement is
`com.apple.security.cs.debugger`; neither cosign/attestation nor mere successful
compilation proves a usable signed helper. A reproducible privately distributed
build could resolve missing cells, but this research has not established its
SDK acquisition/redistribution, signing or runtime closure. No manual SDK install,
keychain/security changes, or system package-manager recipe is accepted here.

**License.** LLVM/LLDB uses Apache-2.0 with LLVM exceptions, includes legacy
NCSA terms and separately licensed third-party material. This permits a plausible
redistribution path with notices, but does not grant redistribution rights for
Apple SDKs or Microsoft's SDK/runtime components; those need separate review if
included. Preserve provenance and notices for the actual shipped closure.

Primary sources:

- [Exact release metadata/assets](https://api.github.com/repos/llvm/llvm-project/releases/tags/llvmorg-23.1.1),
  [release page/package types/verification](https://github.com/llvm/llvm-project/releases/tag/llvmorg-23.1.1).
- [Official DAP procurement and launch documentation](https://lldb.llvm.org/use/lldbdap.html),
  [tagged DAP link target](https://github.com/llvm/llvm-project/blob/llvmorg-23.1.1/lldb/tools/lldb-dap/tool/CMakeLists.txt).
- [Tagged release workflow](https://github.com/llvm/llvm-project/blob/llvmorg-23.1.1/.github/workflows/release-binaries.yml),
  [release CMake cache](https://github.com/llvm/llvm-project/blob/llvmorg-23.1.1/clang/cmake/caches/Release.cmake),
  [Windows x64/ARM64 release script](https://github.com/llvm/llvm-project/blob/llvmorg-23.1.1/llvm/utils/release/build_llvm_release.bat).
- [Tagged build/prerequisite/signing documentation](https://github.com/llvm/llvm-project/blob/llvmorg-23.1.1/lldb/docs/resources/build.md),
  [debugserver architectures, SDK and signing](https://github.com/llvm/llvm-project/blob/llvmorg-23.1.1/lldb/tools/debugserver/source/CMakeLists.txt),
  [macOS public entitlement](https://github.com/llvm/llvm-project/blob/llvmorg-23.1.1/lldb/tools/debugserver/resources/debugserver-macosx-entitlements.plist).
- [Tagged LLDB license](https://github.com/llvm/llvm-project/blob/llvmorg-23.1.1/lldb/LICENSE.TXT).

## CodeLLDB

**Language and launch boundary.** CodeLLDB is an LLDB-backed DAP adapter for
native code, including Rust and C/C++. Its documented launch requires a compiled
`program` (or an explicit Cargo configuration), supports attach, and has many
LLDB-specific options. A Pi preset should initially launch a precompiled
executable only; Cargo build/test inference, attach, remote debugging, LLDB
commands, and source-map/advanced launch behavior need explicit profiles.

**Protocol fit.** The upstream adapter binary defaults to DAP over stdio when
started without `--port`/`--connect`; it can listen on TCP with `--port` or
connect out with `--connect`. It embeds/loads LLDB, starts a bundled Python
interface, and can run one session at a time unless `--multi-session` is used.
The stdio mode is a plausible direct fit for Pi DAP. The adapter's bundled LLDB
and Python are part of the platform package; this is not merely a small Rust
executable.

**Release assets / Windows ARM64.** Latest upstream release observed: `v1.12.3`,
published 2026-08-23. The release API lists:

- `codelldb-linux-x64.vsix`
- `codelldb-linux-arm64.vsix`
- `codelldb-darwin-x64.vsix`
- `codelldb-darwin-arm64.vsix`
- `codelldb-win32-x64.vsix`
- a bootstrap VSIX

There is no `win32-arm64` VSIX. Upstream package metadata maps exactly those
platforms and declares the extension private. Upstream's supported-platform
summary likewise lists Windows x64, not Windows ARM64. A draft upstream PR
(#1387) proposes Windows ARM64 support and depends on a separate LLDB build;
that is evidence of work in progress, not a usable release artifact. Source
compilation may eventually be possible, but the required LLDB build and native
probe are unknown for Pi's Windows ARM64 gate.

**Acquisition and redistribution.** The VSIX contains the adapter, LLDB, and
platform-specific support. The project and its adapter are MIT-licensed, but
Pi would need to preserve the package's license/notice files and securely map
VSIX extraction to the executable and embedded LLDB paths. The current installer
has not proven VSIX acquisition/extraction or a six-platform CodeLLDB composition.

Sources:

- Latest release API and exact assets: <https://api.github.com/repos/vadimcn/codelldb/releases/latest>
- Official platform package map (`package.json`):
  <https://raw.githubusercontent.com/vadimcn/codelldb/master/package.json>
- Adapter CLI source showing stdio/TCP modes and LLDB loading:
  <https://raw.githubusercontent.com/vadimcn/codelldb/master/src/codelldb/src/lib.rs>
- Launch requirements and Cargo/attach behavior: <https://raw.githubusercontent.com/vadimcn/codelldb/master/MANUAL.md>
- Official supported-platform summary: <https://github.com/vadimcn/codelldb>
- Windows ARM64 support draft and dependency on an LLDB build:
  <https://github.com/vadimcn/codelldb/pull/1387>
- MIT license: <https://raw.githubusercontent.com/vadimcn/codelldb/master/LICENSE>

## NetCoreDbg (.NET)

**Language and protocol.** NetCoreDbg implements VSCode DAP, GDB/MI, and CLI
interfaces for CoreCLR. Its documented invocation is:

```text
netcoredbg --interpreter=vscode -- /path/to/dotnet /path/to/program.dll
```

That means the adapter requires a .NET runtime/debuggee command and a managed
assembly with suitable symbols. A Pi direct-script preset would need a clear
policy for selecting a private/project .NET runtime and `.dll`; it must not infer
solution builds or project dependency installation.

**Release assets / native coverage.** Latest release API observed: `3.2.0-1092`,
published 2026-06-25. Assets include Linux amd64/arm64, macOS arm64, and a
`win64.zip`; there is no macOS x64 asset and no Windows ARM64 asset. The release
therefore does not supply archives for all six targets; supported subsets may now
be considered under the clarified platform policy.

**Source-build fallback.** The upstream README says builds exist for Linux,
macOS, and Windows and lists ARM64 among supported architectures, but its details
are materially heavier than a normal private binary install: .NET runtime/SDK,
CoreCLR source, CMake, clang, and platform toolchains are involved. The README
also says macOS ARM64 is community-supported and may not work as expected. It
provides no concrete Windows ARM64 release or Pi-compatible source-build proof.
A source build should therefore be treated as an experiment, not a basis for a
builtin preset.

**License.** NetCoreDbg is MIT-licensed. That is favorable, but does not resolve
missing release cells, runtime acquisition, or build reproducibility.

Sources:

- Latest release API and exact assets: <https://api.github.com/repos/Samsung/netcoredbg/releases/latest>
- Official README: <https://raw.githubusercontent.com/Samsung/netcoredbg/master/README.md>
- DAP/CLI invocation details: <https://raw.githubusercontent.com/Samsung/netcoredbg/master/docs/cli.md>
- Build architecture configuration: <https://raw.githubusercontent.com/Samsung/netcoredbg/master/CMakeLists.txt>
- MIT license: <https://raw.githubusercontent.com/Samsung/netcoredbg/master/LICENSE>

## Narrow follow-up: Deno through existing `vscode-js-debug`

**Accepted catalog addition, not yet verified in Pi.** Deno's official documentation says
its inspector speaks V8 Inspector Protocol and that its VS Code integration
launches a single entry file through a `node` debug configuration. More directly,
released js-debug **v1.117.0** documents `attachSimplePort` specifically for Deno
launches; `0` chooses a random port and adds `--inspect-brk`. It also documents
`runtimeExecutable` and `runtimeArgs`, and distributes a standalone DAP server.
Thus reusing Pi's existing adapter for a direct Deno script is a concrete upstream
path, not just an inference from shared V8. It would still require a Deno-specific
Launch Profile and private Deno runtime in addition to the adapter's Node runtime;
VS Code's editor integration is not itself a Pi requirement or compatibility proof.

**Released native runtime matrix.** Deno **v2.9.6**, published 2026-08-27, has all
six CLI archives (plus per-archive checksums), with no source fallback required
by the asset matrix:

| Native cell   | Release asset                        |
| ------------- | ------------------------------------ |
| Linux x64     | `deno-x86_64-unknown-linux-gnu.zip`  |
| Linux ARM64   | `deno-aarch64-unknown-linux-gnu.zip` |
| macOS x64     | `deno-x86_64-apple-darwin.zip`       |
| macOS ARM64   | `deno-aarch64-apple-darwin.zip`      |
| Windows x64   | `deno-x86_64-pc-windows-msvc.zip`    |
| Windows ARM64 | `deno-aarch64-pc-windows-msvc.zip`   |

**Boundary/unknowns.** A candidate profile would launch a local script with
`deno run` and a loopback inspector, not `deno task`, a dev server, test runner,
`deno compile`, or an inferred project build. Deno documents `--inspect-brk`
without any blanket permission grant; do not copy `-A`/`--allow-all` from unrelated
framework examples. Debuggee permissions remain explicit. The docs establish
launch feasibility and released runtime availability, not Pi's six-cell startup,
source-map breakpoints, primary-target handshake, execution/variables/evaluation,
or stop/cancellation behavior. Private cache placement and avoiding project
lockfile/dependency changes also remain recipe requirements. js-debug warns that
`attachSimplePort` loses child-process debugging; workers/extra sessions are not
part of this proposed direct-script boundary. No binaries were acquired or run.

Sources:

- [Deno inspector flags and loopback security](https://docs.deno.com/runtime/fundamentals/debugging/),
  [official single-entry VS Code/node integration](https://docs.deno.com/runtime/reference/vscode/#using-the-debugger).
- [Released js-debug options: `attachSimplePort`, runtime selection](https://github.com/microsoft/vscode-js-debug/blob/v1.117.0/OPTIONS.md),
  [standalone DAP usage](https://github.com/microsoft/vscode-js-debug/blob/v1.117.0/README.md).
- [Exact Deno v2.9.6 release assets/digests](https://api.github.com/repos/denoland/deno/releases/tags/v2.9.6).

## Follow-up: Deno native controls and existing Pi boundaries

The following are released Deno v2.9.6 controls, not new Pi settings or verified
Pi behavior. They distinguish dependency/cache operations from Debuggee runtime
permissions; neither Installed-only Mode nor permission flags provide a general
network sandbox.

### Cache and dependency writes

- CLI cache placement uses `DENO_DIR`, not an invented `--cache-dir` argument.
  LSP `deno.cache` takes precedence over the environment and accepts an absolute
  private cache path. Pi must pass the native setting through initialization or
  workspace configuration, not invent a top-level Pi option.
- LSP `cacheOnSave` defaults to true in released source, even though the current
  integration manual omits it. On uncached-import diagnostics, saving can invoke
  dependency caching and network access. Setting it false stops that automatic
  path; explicit `deno/cache` or cache code actions can still download dependencies.
  No LSP `cachedOnly`, `noRemote`, or read-only-cache option was found.
- LSP passes `lockfile_skip_write=true`. Its resolver still reads the project's
  `lock.frozen` setting when no explicit frozen override is supplied. Without frozen
  mode it can resolve a changed graph in memory while leaving the lockfile untouched;
  write suppression is not the same as enforcing a frozen graph.
- LSP normally avoids changing `node_modules`, but explicit `nodeModulesDir`/vendor
  configuration can opt into writes. Disabling cache-on-save alone is not a proof
  that every project configuration is write-free. Those configurations need tests
  and safe refusal where the no-project-dependency-write contract cannot be met.
- `deno run --cached-only` requires cached remote dependencies; `--frozen` enforces
  lockfile consistency. They solve different problems. `--node-modules-dir=manual`
  uses existing local modules without modifying them, whereas `none` uses the
  global cache and can change bare-import behavior; `auto` installs local modules.
  Do not bypass project integrity with `--no-lock` merely to avoid a write.

### Debuggee permissions

Deno defaults to no arbitrary runtime filesystem, network, environment, or
subprocess access. `--no-prompt` or `DENO_NO_PROMPT` disables permission prompts;
scoped `--allow-*` grants and overriding `--deny-*` controls are separate from
cache, lockfile, and module-loading policy. Static imports and dependency-cache
operations can occur outside ordinary runtime read/write permission checks, and
the native language server is not a permission-sandboxed Deno script. In
particular, granting `--allow-run` lets a spawned program operate independently;
never substitute `-A` for an explicit permission decision.

### Existing Pi ownership and customization

`resolveDapPreset` yields to configured profile IDs, including null/quarantined
ones; any configured profile also prevents unnamed automatic preset selection.
An explicit failure never falls back to a builtin. When no explicit profile owns
the request, existing named/direct-script presets supply their own launch profile.
Deno selection must preserve these rules, not add a second inference path that
bypasses them.

Pi LSP currently has no preset-settings overlay. Custom `settings` and
`initializationOptions` belong to a complete Explicit Definition with command and
language mappings; that definition suppresses presets. For Deno workspace
configuration, `settings` has sections such as `{ deno: { cache, cacheOnSave } }`,
whereas `initializationOptions` is the Deno namespace object. Do not document a
nonexistent lightweight override or add a generic customization layer implicitly.

Primary sources:
[Deno LSP integration](https://docs.deno.com/runtime/reference/lsp_integration),
[released LSP fields](https://github.com/denoland/deno/blob/v2.9.6/cli/lsp/config.rs#L525-L548),
[LSP resolver flags](https://github.com/denoland/deno/blob/v2.9.6/cli/lsp/config.rs#L1294-L1313),
[node_modules policy](https://github.com/denoland/deno/blob/v2.9.6/cli/lsp/config.rs#L2080-L2103),
[cache path](https://github.com/denoland/deno/blob/v2.9.6/cli/lsp/language_server.rs#L806-L847),
[automatic caching](https://github.com/denoland/deno/blob/v2.9.6/cli/lsp/language_server.rs#L1451-L1485),
[cache request flags](https://github.com/denoland/deno/blob/v2.9.6/cli/lsp/language_server.rs#L4412-L4447),
[resolver lockfile policy](https://docs.rs/crate/deno_resolver/0.89.0/source/lockfile.rs#L340-L365),
[run options](https://docs.deno.com/runtime/reference/cli/run),
[environment controls](https://docs.deno.com/runtime/reference/env_variables),
[project lock/modules configuration](https://docs.deno.com/runtime/reference/deno_json/),
[permissions](https://docs.deno.com/runtime/reference/permissions).
Local sources:
[`dap-managed-tools.ts`](../../packages/pi-dap/src/dap-managed-tools.ts#L70-L110),
[`dap-session.ts`](../../packages/pi-dap/src/dap-session.ts#L440-L451),
[`pi-lsp-settings.ts`](../../packages/pi-lsp/src/pi-lsp-settings.ts#L24-L48),
[`lsp-server-client.ts`](../../packages/pi-lsp/src/lsp-server-client.ts#L836-L840).

## Follow-up: .NET runtime selection and private launch

Checked 2026-09-12, without installation or execution. Compiled application metadata,
not an SDK's latest version, determines runtime compatibility.

### Metadata and native policy

`runtimeOptions.framework` or `frameworks` identifies framework-dependent roots;
version requirements and native `rollForward`/legacy patch policy govern selection.
Default `Minor` is not permission to jump arbitrarily to the newest major.
Referenced frameworks may themselves depend on others, so reading the root list
alone does not prove a complete compatible graph. Let the host enforce that graph;
report unsupported or conflicting requirements rather than overriding policy.

Self-contained apphosts carry their runtime. `includedFrameworks` can describe
that bundle, but missing runtimeconfig metadata alone is not sufficient evidence
to choose or download a runtime. `tfm` alone is not a framework/version declaration,
and runtimeconfig does not establish process architecture; RID/apphost information
is separate. Unknown framework identities, ambiguous metadata, or cross-architecture
requirements need an explicit boundary rather than host-architecture guessing.

### NetCoreDbg launch behavior

The released 3.2.0-1092 handler does **not** consume VS Code's `runtimeExecutable`.
Without a startup command, a `.dll` launch executes literal `dotnet` from PATH.
To select a private host, the adapter's startup arguments can supply
`-- /absolute/dotnet /absolute/app.dll ...`; then the adapter ignores launch-request
`program`/`args`. Pi must therefore preserve the user's program/argument precedence
when constructing that startup command. For an apphost, launch the executable and
set the appropriate `DOTNET_ROOT_<ARCH>`/`DOTNET_ROOT` when an external runtime is
needed. `DOTNET_ROOT` alone does not redirect a literal `dotnet` invocation.

Adapter environment and launch `env` reach the Debuggee. No generic
`DOTNET_ROLL_FORWARD=LatestMajor` override is acceptable: it would change the
application's native compatibility policy. No project build follows from resolving
a runtime or launching a compiled assembly.

### Existing acquisition route and isolation gap

Mise's native dotnet plugin supports runtime-only installation through
`dotnet[runtime=dotnet|aspnetcore|windowsdesktop]@<exact runtime version>`; it delegates
to the official installation script. Its ordinary remote version list is SDK
versions, so a runtime-only `@8` channel is not a correct way to discover runtime
patches. The current ToolInstaller resolves every selector through `mise latest`
and then installs the concrete result; it has no target-metadata version-selection
seam. Supporting compatible/exact runtime selection is necessary work, not evidence
that a custom .NET backend is needed or that the latest SDK always satisfies an app.

Installer-private HOME and cache settings are not automatically exported in
`ManagedInstallation.environment`; the launch owner must account for CLI/runtime
state as well. Where relevant, native controls include private `DOTNET_CLI_HOME`
and `NUGET_PACKAGES`, telemetry opt-out, disabling first-use ASP.NET certificate
generation, workload/vulnerability metadata refresh, and global-tools PATH changes.
`DOTNET_NOLOGO` only hides the welcome message, and
`DOTNET_SKIP_FIRST_TIME_EXPERIENCE` is unsupported since .NET 3.0; neither is an
isolation substitute. Runtime-only acquisition avoids unnecessary SDK behavior,
but actual no-system/no-project-write behavior still needs native tests.

Sources:
[SDK runtimeconfig specification](https://raw.githubusercontent.com/dotnet/sdk/b8600c8854f5d1ac1442d717211d968f69a53acd/documentation/specs/runtime-configuration-file.md),
[native version selection](https://github.com/dotnet/docs/blob/45d22543cf002fb88caf8938c2580740c69d3f25/docs/core/versions/selection.md),
[NetCoreDbg launch handler](https://raw.githubusercontent.com/Samsung/netcoredbg/3.2.0-1092/src/protocols/vscodeprotocol.cpp),
[NetCoreDbg CLI](https://github.com/Samsung/netcoredbg/blob/3.2.0-1092/docs/cli.md),
[environment controls](https://github.com/dotnet/docs/blob/6b94bd8af573d315cd45b8d7dd8adc38bb3f6693/docs/core/tools/dotnet-environment-variables.md),
[apphost versus dotnet lookup](https://github.com/dotnet/docs/blob/4b79fe2c05468e70184b4ea0526acdb07123b3b1/docs/core/compatibility/deployment/7.0/multilevel-lookup.md),
[official installer](https://github.com/dotnet/docs/blob/2541530cee6e8071255aba4c65c7cb56cd0d3fa7/docs/core/tools/dotnet-install-script.md),
[mise dotnet source](https://raw.githubusercontent.com/jdx/mise/v2026.9.5/src/plugins/core/dotnet.rs),
[mise dotnet documentation](https://mise.jdx.dev/lang/dotnet.html),
[local installer acquisition/environment](../../packages/pi-tool-installer/src/index.ts#L518-L596).

## Verification needs and the unselected LLVM alternative

- Delve: explicitly experimental release-tag Windows ARM64 build and native
  lifecycle evidence; clean-macOS private debugserver/signing solution on both CPUs.
  Delve is selected, but Windows ARM64 support has not been claimed; do not treat
  an experimental build as an already supported cell.
- Deno with existing js-debug: six runtime assets and a documented adapter launch
  path exist; private recipe and Pi native lifecycle/source-map proofs remain.
- LLVM `lldb-dap` versus CodeLLDB: close their different missing release cells,
  prove private runtime/helper closure, and compare actual Rust/C/C++ behavior.
  LLVM's ARM64 Windows archive is a meaningful alternative, not six-cell proof.
- NetCoreDbg: resolve the documented missing release cells and private .NET/CoreCLR
  build/runtime story before treating it as a supported Language Tool Preset.
- No installs, builds or adapter executions were performed for this follow-up.
  Deno, Delve, CodeLLDB, and NetCoreDbg are selected, but Pi integration and proofs
  remain outstanding. Delivery is all-at-once, not staged around whichever
  selected preset passes first.
- Do not treat OpenCode's debugger absence, generic DAP support, source availability,
  release assets, or “supported architecture” text as native Pi compatibility proof.
