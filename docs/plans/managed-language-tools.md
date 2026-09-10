# Managed language tools

Status: implementation under verification, 2026-09-10. **The initial six-platform
acquisition and launch gate passed; final integration and release gates remain.**
[Run 34520581283](https://github.com/ian-pascoe/pi-extensions/actions/runs/34520581283)
at `59c17f0` passed all 11 checks on each of the six native targets. See the
[verified baselines and concrete versions](../../packages/pi-tool-installer/README.md#initial-verified-baselines).
The probes include first-use private acquisition, LSP document requests, formatter
output, and JavaScript/Python debugging. This does not yet prove separate-process
coordination, actual-install interruption, immutable Python updates, or extension
lifecycle/precedence and SDK prefix stability. Package-owned defaults and their
offline SDK proofs are implemented; the hardened native matrix and final repository
checks must pass before this plan is considered complete.

The user selected TypeScript 7 rather than a TypeScript 6 compatibility pin.
Use TypeScript 7's built-in native LSP (`tsc --lsp --stdio`), not the separate
TypeScript Language Server wrapper that requires the old `tsserver.js` API.
Fresh private TypeScript 7.0.2 acquisition, initialization, and document-symbol
requests for both TypeScript and JavaScript passed on all six native targets.
See the [TypeScript 7 native LSP findings](../research/typescript-7-native-lsp.md).

Vocabulary: [Language Tools](../contexts/language-tools/CONTEXT.md),
[Pi LSP](../../packages/pi-lsp/CONTEXT.md),
[Pi DAP](../../packages/pi-dap/CONTEXT.md), and
[Pi Formatter](../../packages/pi-formatter/CONTEXT.md).
Ownership decision: [ADR-0004](../adr/0004-own-language-presets-and-share-managed-installation.md).

## Outcome and initial catalog

Provide useful defaults and automatic installation together in the first release.
Users do not need to install or configure mise or Neovim separately.

| Language              | LSP                     | Formatting                                           | Initial debugging                                   |
| --------------------- | ----------------------- | ---------------------------------------------------- | --------------------------------------------------- |
| TypeScript/JavaScript | TypeScript 7 native LSP | Prettier or Biome, selected by project configuration | vscode-js-debug for direct Node JavaScript launches |
| Python                | Pyright                 | Ruff or Black, selected by project configuration     | debugpy for direct Python script launches           |
| Go                    | gopls                   | gofmt                                                | Not initially                                       |
| Rust                  | rust-analyzer           | rustfmt                                              | Not initially                                       |

Package-owned Language Tool Presets define file matching, roots, commands,
arguments, initialization settings, and the relevant launch behavior. The shared
installer handles acquisition of executables and their required runtimes; it does
not infer these package-specific policies from installation metadata.

## First-class platform contract

Native **x64 and ARM64 on each of Linux, macOS, and Windows** are equal release
gates. No OS is an optional follow-up and emulation does not prove native support.
The implementation must establish and document its minimum OS/runtime baselines
and test each supported tool on all six OS/architecture combinations.

Missing release artifacts, Python wheels, prerequisite components, or native CI
runners are explicit blockers to resolve or bring back to the user. Do not silently
shrink the matrix. Conversely, absence of a wheel is not proof that a supported
source or pure-Python installation is impossible. Inspect and test the actual path.

## Configuration and executable precedence

Built-ins are fallbacks. Explicit matching definitions suppress automatic defaults
for the same files even when their IDs differ. Multiple explicitly configured
servers remain supported; do not guess whether an additional built-in complements
a user's configuration. An explicit DAP selection retains ownership of its adapter
and Launch Profile.

Resolve executable choices in this order:

1. Explicit Pi configuration.
2. Project-local executable or runtime.
3. Executable or runtime available on the user's PATH.
4. Existing or newly acquired Managed Installation.

Reading PATH is allowed. Modifying the user's PATH, shell startup files, project
manifests, or system-wide tool selections is not. Required environment changes
belong only to child processes. Never silently replace an explicit failing command
with a different tool.

Keep Pi's existing trusted-project settings boundary, reload lifecycle, same-ID
replacement, quarantine, null-shadowing, and enablement semantics. Test their
interaction with the new fallback layer: disabling or quarantining a definition
must not silently resurrect its same-ID default. A runtime failure is not a reason
to reinterpret an Explicit Definition as permission for a built-in replacement.

Installation policy belongs in Pi settings, not a user-maintained mise.toml or a
separate extension settings file. The exact settings key and schema are an
implementation detail to reconcile with the installed SDK and existing parsers.

## Formatter selection

For JavaScript/TypeScript and Python, use Formatter Markers rather than imposing a
formatter merely because the file extension is recognized:

- Recognize formatter-specific configuration files and explicit formatter
  declarations inside manifests.
- package.json alone does not select Prettier; pyproject.toml alone does not select
  Ruff or Black. Inspect the relevant declarations, not substring coincidences.
- Select the nearest applicable project configuration for the affected file,
  including nested packages in a monorepo.
- Conflicting selections at the same root produce a warning and require an explicit
  choice. Do not run both built-in alternatives or silently choose by catalog order.
- With no declared preference, do not automatically format Python or JS/TS files.
- Conventional gofmt and rustfmt defaults need no competing-style selection.

Preserve existing per-file Activation Gates and explicit multi-formatter behavior.
Marker changes must take effect through the existing routing/formatting lifecycle;
a stale cached preference must not continue choosing the wrong formatter.

## Debugging boundary

Initial zero-configuration Launch Profiles cover direct Node JavaScript files and
Python scripts. Prefer the project's runtime where available. Adapter runtimes and
Debuggee runtimes are separate concerns: a private debugpy installation must not
require injecting debugpy into the project's environment.

Framework launchers, test runners, TypeScript loaders, and build steps require an
explicit Launch Profile. Do not invent how the project runs. No automatic project
dependency installation or Debuggee build is included. Preserve Pi DAP's one Debug
Session, tested adapter contract, and existing protocol boundaries.

## Automatic installation and isolation

Installation is automatic from the outset, with no opt-in prompt. It happens on
**first actual need**, not when Pi starts or merely discovers a project:

- An LSP operation or applicable Post-edit Diagnostics can need a server.
- A qualifying mutation can need the selected formatter.
- A debug launch can need its adapter.

The first dependent operation waits with visible progress and cancellation. Do not
silently skip that first request or format a file later in a detached background
job. Keep existing successful mutation results successful if installation or
formatting fails; explain unavailable assistance in the result. Explicit LSP
requests and debug launches report actionable failure instead of apparent success.

Install required runtimes and toolchain components as well as the tool itself.
This includes TypeScript's native compiler/server distribution, Node/Python requirements,
and components needed for gofmt/rustfmt. No manual language-manager prerequisite
should be hidden in the out-of-the-box promise.

"Portable" means a private, self-contained installation **on each machine** with
no system changes. It does not require copying an installed directory to another
location or machine without reinstalling.

Use one private per-user store shared by all three packages, projects, worktrees,
and Pi processes. Deduplicate concurrent requests for the same tool/version with
process-safe coordination. Stage installations before making them selectable and
retain working versions on failed or cancelled updates. An interrupted install
must not look like a usable tool. Session reloads must not erase durable installation
knowledge or require downloading the same tool again.

Pi settings remain the configuration authority. External storage is justified for
actual binaries, supporting runtimes, installation metadata, and cross-process
coordination: Pi's session journal is not an executable installation store. Do not
use this need to create a parallel session or configuration database.

### Installed-only Mode

A Pi setting disables automatic downloads but retains discovery and use of existing
External and Managed Installations. Missing prerequisites produce actionable
unavailability without downloading the Installer Helper as a side effect.

Explicit Tool Updates remain deliberate network actions; Installed-only Mode is
not a network sandbox or a claim of fully offline execution. Previously installed
tools must remain usable without a registry refresh.

## Version and update policy

Use **latest upstream on first installation or explicit Tool Update**, not versions
pinned to an extension release. Resolve and record the concrete installed version;
"latest" must not make a running tool or an existing installation change on every
request. Reuse installed versions until explicitly updated.

User commands:

```text
/lsp update
/lsp update typescript
/formatter update
/dap update
```

Each package's update command covers its installed Managed Installations; an
optional definition ID targets one. The existing /lsp command gains this operation;
Pi Formatter and Pi DAP provide corresponding commands. Idle TUI updates use an
Escape-cancellable loader; RPC/headless updates expose `/<package> update cancel`.
Cancellation waits for acquisition cleanup before completing the command.

Updates must:

- Show old and new versions, including per-tool failure or no-change outcomes.
- Leave project-local and PATH installations untouched.
- Avoid installing unused presets as a side effect of "update all".
- Preserve the working version if the new installation fails.
- Leave existing Server Instances and Debug Sessions on their current executables;
  updated installations are selected for subsequent starts.
- Include progress and a cancellation path, including idle slash-command execution.

Use concrete per-version installations rather than overwriting files used by live
processes, particularly on Windows. Automatic upgrades at session startup, background
upgrade checks, and project dependency updates are not part of this design.

## Installer implementation direction

Use one shared internal installer backed by a privately provisioned mise. All three
extensions remain independently usable; users do not install another extension or
configure mise. Keep package-specific Language Tool Presets with their existing
owners. Choose the shared library's packaging against the repository's source-TS
extension/compiled-library convention rather than introducing a general plugin
framework or putting language policy into UI-only helpers.

Mise is an implementation dependency, not the configuration authority. Investigate
its no-config mode and private data/cache/config directories; verify isolation from
all ambient configuration and environment that could change backend selection,
execute project hooks, or write outside the private store. Invoke explicit install
and resolution operations, rather than depending on an execution helper's hidden
auto-install behavior. Do not run shell activation or trust/configuration commands
against the user's project.

Use reviewed package identities and tool-specific acquisition mappings. Consuming
a registry is not permission to execute arbitrary workspace-provided recipes.
Verify downloaded artifacts using available integrity/provenance mechanisms and
validate archive extraction paths. Record limitations honestly: exact top-level
versions do not prove reproducible transitive dependencies or universal checksum
coverage across backends.

### Acquisition mappings

- TypeScript 7, Pyright, Prettier, and Biome have package-manager acquisition paths,
  but their selected versions' runtime requirements must be satisfied privately.
  TypeScript's npm launcher needs Node and its matching optional native platform
  package; the same `tsc` entrypoint provides compilation and native LSP service.
- Ruff and rust-analyzer have release-binary acquisition paths. gofmt/rustfmt come
  from toolchain distributions/components rather than independent tool packages.
- The vscode-js-debug standalone DAP archive contains a JavaScript entrypoint such
  as js-debug/src/dapDebugServer.js. It needs Node and an explicit script path, not
  generic "find an executable in this GitHub release" behavior.
- debugpy needs a suitable Python environment and platform-compatible packaging.
  Wheel availability varies with Python, OS version, architecture, and release;
  validate all six cells, including fallback paths and their prerequisites.
- A successful registry or version-listing request is not proof of installation,
  executable resolution, or protocol startup. Generic backend availability is not
  a per-tool platform guarantee.

## Native ownership and implementation sequence

1. **Prove acquisition on the whole matrix first.** Bootstrap the private helper,
   install the selected tool/runtime combinations, resolve their commands, and run
   minimal LSP/formatter/DAP probes. Establish minimum platform baselines and capture
   exact versions. Bring unsolved gaps back rather than narrowing support.
2. **Implement the shared installation boundary.** Reuse mise for acquisition and
   storage primitives where they meet the contract; add only missing policy,
   coordination, and selection. Prove no user/project configuration or PATH changes.
3. **Add package-owned presets and fallback resolution.** Preserve existing settings,
   null/invalid shadowing, enablement, file/root routing, formatter ordering, and
   explicit DAP behavior. Add marker-aware formatter selection and direct-launch
   profiles without expanding into arbitrary project setup.
4. **Integrate lifecycle, progress, cancellation, and updates.** Use Pi's existing
   hooks. Keep network work out of session_start. Tool execution has a cancellation
   signal; idle update commands need their own cancellable operation lifetime.
5. **Finish docs and release gates.** Update the currently settings-only package
   READMEs/contexts and relevant support skills when runtime behavior changes. Add
   Changesets for every releasable package, following docs/releases.md. Do not
   publish or claim implementation success based on this design document.

Current source seams to inspect before changing them:

- packages/pi-lsp/src/pi-lsp-settings.ts, pi-lsp-extension.ts,
  lsp-server-manager.ts, lsp-server-client.ts, lsp-command.ts, and lsp-tool.ts.
- packages/pi-formatter/src/pi-formatter-settings.ts and pi-formatter-extension.ts.
- packages/pi-dap/src/pi-dap-settings.ts, pi-dap-extension.ts, dap-session.ts,
  dap-protocol-client.ts, and dap-tool.ts.

Check installed Pi APIs and exports, not only reference HEAD. Native settings/trust,
reload/session cleanup, and tool registration remain with Pi. Pi DAP and Pi LSP use tool onUpdate progress; formatter middleware
has a context cancellation signal but no tool progress callback and reports through
native status and mutation-result feedback. Idle updates own a cancellable operation
lifetime rather than relying on an active agent turn.

Formatter middleware must still finish before subsequent LSP diagnostics middleware.
Neither installer failure nor aborted assistance may erase an already-completed
mutation. No install-status-driven changes to ordered tool definitions or system
prompts are needed.

## Verification gates

Use existing offline fixtures for routine regression tests; do not let a unit test
incidentally install tools or access the network. Add explicit installation suites
on isolated native runners for real acquisition and launch coverage.

- All six OS/architecture combinations: fresh private bootstrap, each preset and
  required runtime, LSP initialization/request, formatter output, and Node/Python
  launch/breakpoint/stack/continue/stop. Capture actual versions and platform baselines.
- Standalone LSP, DAP, and Formatter; combined Formatter-before-LSP; existing
  CodeMode and Subagent modes that can expose or concurrently invoke these tools.
- Concurrent calls and separate Pi processes; one acquisition per shared concrete
  tool/version; interruption, reload, failure, retry, and atomic publication.
- External/project/PATH precedence, explicit matching definitions under different
  IDs, disabled/null/quarantined settings, and no accidental duplicate defaults.
- Nested Formatter Markers, manifest declarations, same-root conflicts, marker
  changes, no-preference Python/JS, and existing explicit formatter chains.
- Fresh installed-only operation with no helper, offline reuse, cancellation during
  installation, failed updates preserving prior versions, and live processes staying
  on their original versions.
- No changes to user PATH/shell files, external tool versions, project manifests,
  user mise configuration, or unrelated user data. Include paths with spaces and
  Unicode, executable shims, and native Windows process/locking behavior.
- Offline SDK prefix proofs compare affected **ordered serialized tool definitions,
  system prompts, and message history**, not just tool-name sets or token estimates.
  Installation progress belongs in appropriate UI/results, not mutable schema text.

Run the repository's existing verification, package-pack, and Git-install checks
when implementation lands. Missing native evidence is a reported verification gap,
not a passing platform claim.

## Research references

- OpenCode reference inspected at b3f1a96c6dd7adeb28b36dd11add1998fc84d67b:
  [LSP definitions](https://github.com/anomalyco/opencode/blob/b3f1a96c6dd7adeb28b36dd11add1998fc84d67b/packages/opencode/src/lsp/server.ts),
  [formatter definitions](https://github.com/anomalyco/opencode/blob/b3f1a96c6dd7adeb28b36dd11add1998fc84d67b/packages/opencode/src/format/formatter.ts).
  These are application-owned recipes, not an independently reusable registry.
  Some Npm.which paths install on cache misses; do not copy their discovery or
  download-disable behavior without tracing the installer.
- [Mason registry](https://github.com/mason-org/mason-registry) and
  [mason.nvim](https://github.com/mason-org/mason.nvim): package metadata/recipes and
  a Neovim installer, not complete Pi definitions. No Mason runtime dependency.
- [mise registry](https://mise.jdx.dev/registry.html),
  [install](https://mise.jdx.dev/cli/install.html),
  [where](https://mise.jdx.dev/cli/where.html),
  [CLI flags](https://mise.jdx.dev/cli/),
  [configuration](https://mise.jdx.dev/configuration.html), and
  [lockfile limitations](https://mise.jdx.dev/dev-tools/mise-lock.html).
- [nvim-lspconfig](https://github.com/neovim/nvim-lspconfig),
  [conform.nvim](https://github.com/stevearc/conform.nvim), and
  [Helix languages.toml](https://github.com/helix-editor/helix/blob/master/languages.toml)
  are behavioral references, not runtime dependencies. Review licensing before
  copying code; independently author Pi definitions rather than importing catalogs.
- [vscode-js-debug](https://github.com/microsoft/vscode-js-debug) and
  [debugpy](https://github.com/microsoft/debugpy) are the adapter authorities.

## Explicit non-goals

No Mason recipe interpreter, arbitrary registry-plugin framework, automatic upgrades
on startup, all-language preload, system PATH changes, project dependency management,
relocatable installation-directory guarantee, or initial Go/Rust debugging. No
separate model-facing installation tool or extra user-configured extension is
required by this design. Existing explicitly configured capabilities are not removed.
