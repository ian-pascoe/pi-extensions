# Language Tool Preset expansion

Status: implementation in progress, 2026-09-12. Decisions 1–22 below are accepted,
and the user authorized implementation, verification, review, and a commit on the
current branch. New preset support claims remain pending native verification.

## Accepted scope

1. **Curated expansion, not OpenCode parity.** Use OpenCode as a reference, then
   agree on a concrete catalog without inheriting every alternative or its
   application-specific behavior.
2. **All three packages are in scope.** Expand Pi LSP, Pi Formatter, and Pi DAP,
   without requiring identical language coverage. A useful LSP/formatter preset
   does not imply that a suitable debugger preset exists.
3. **Web, framework, and configuration coverage is the priority.** The concrete
   catalog in decisions 10–12 and 20–21 bounds that expansion; the earlier priority
   examples do not imply additional ecosystems or a separate later delivery batch.
4. **Ship the complete agreed catalog at once.** Do not release independently
   verified batches. Implementation and investigation may be incremental, but all
   agreed presets must meet their gates before release. A blocked candidate blocks
   release unless the user explicitly revises the agreed scope.
5. **Include Lint Companions.** Add ESLint, Biome, and Oxlint LSP companion support
   rather than deferring it. Existing formatter support is not removed.
6. **Preserve deliberate formatter selection.** Newly supported file types require
   Formatter Markers where choices compete. Conventional formatters may activate
   automatically where appropriate, following the gofmt/rustfmt pattern. Conflicting
   markers require an explicit choice rather than a catalog-order winner.
7. **Run every project-declared, enabled Lint Companion.** Do not choose one winner
   when several coexist, or activate linters from file extensions alone. Existing
   explicit-definition suppression and enablement rules still take precedence.
8. **Automatic diagnostics, requested fixes.** Lint Companions report diagnostics
   automatically but do not automatically apply fixes after edits. Requested fixes
   use Workspace Edit Preview followed by guarded Apply; require an explicit
   `server_id` when several capable servers can produce edits.
9. **Permit private framework compatibility SDKs and integration.** Framework
   presets may acquire the latest-compatible TypeScript SDK dependencies and use
   the required framework-specific integration and routing. TypeScript 7 remains
   the default outside that compatibility path; project dependencies remain
   unchanged. Vue requires a proven tsserver integration bridge, not merely an
   older SDK installation. [ADR-0005](../adr/0005-isolate-framework-typescript-compatibility.md)
   records the compatibility exception to the latest-version policy.
10. **Accepted LSP catalog.** Add Vue, Svelte, Astro, Deno, HTML, CSS/SCSS/LESS,
    JSON/JSONC, YAML, Bash/shell, Dockerfile, and Terraform, alongside the existing
    presets and accepted ESLint/Biome/Oxlint companions. Java, .NET, Ruby, Elixir,
    and other additional ecosystems are outside this expansion.
11. **Direct Deno debugging.** Add direct Deno JavaScript/TypeScript debugging using
    the existing JavaScript adapter, without inferred builds/tasks or blanket
    permissions. Existing JavaScript and Python support remains. Decision 21 adds
    compiled-language debuggers under the clarified platform policy.
12. **Accepted Formatter catalog.** Expand Prettier routing to HTML, CSS/SCSS/LESS,
    JSON/JSONC/JSON5, YAML, Markdown/MDX, GraphQL, and Vue; add Svelte and Astro
    through their Prettier plugins. Expand Biome routing to its stable JSON/JSONC,
    CSS, and GraphQL support. Add shfmt for shell, Terraform CLI's fmt, and Deno
    fmt for stable JS/TS, Markdown, JSON/JSONC, HTML, CSS/SCSS/LESS, and YAML
    formatting. Exclude experimental Biome HTML/framework and Deno component
    formatting from builtin routing; Explicit Definitions remain available.
    Existing formatter support and deliberate marker selection remain.
13. **Privately supply compatible framework formatter plugins.** Prefer compatible
    project installations; otherwise acquire the curated Svelte/Astro plugins
    privately for upstream-supported formatter/framework combinations. Do not
    upgrade project dependencies, replace a selected external formatter, or acquire
    arbitrary project-configured plugins. Explain unsupported combinations rather
    than forcing an incompatible newest plugin. The latest-compatible policy also
    applies to these plugin dependencies.
14. **Concrete formatter selection.** Deno fmt requires a `fmt` declaration in
    `deno.json`/`deno.jsonc`, or an Explicit Definition; a runtime configuration
    alone is not a Formatter Marker. Only format-capable candidates participate in
    conflicts, so a Biome marker does not conflict with Prettier for Markdown.
    Select shfmt/Terraform fmt conventionally for supported shell/Terraform files;
    preserve nearest applicable marker precedence and explicit conflict resolution.
15. **Provide opt-in Oxlint type-aware support.** Enable it when the project opts
    in, preferring compatible external helpers and otherwise privately acquiring
    compatible `oxlint-tsgolint`. Project dependencies and generated declarations
    remain project-owned; do not install or build them automatically. Published
    native packages are not a substitute for Pi integration proof.
16. **Six-platform installer, platform-specific presets.** The user clarified that
    native Linux/macOS/Windows x64+ARM64 support is required for the shared installer,
    not for every default tool. A preset may support a documented subset of those
    platforms. This supersedes the earlier universal per-preset gate, not private
    acquisition or verification of claimed support. See
    [ADR-0006](../adr/0006-separate-installer-and-preset-platform-support.md).
    The external-only ShellCheck recommendation was rejected; decision 20 records
    its accepted managed inclusion under this corrected constraint.
17. **Use Deno project configuration for runtime selection.** `deno.json` or
    `deno.jsonc` selects Deno for automatic direct-script debugging and instead of
    the plain TypeScript 7 LSP within that project, even with a package manifest.
    Preserve explicit profile/adapter/server ownership. Outside Deno projects,
    keep Node/TypeScript defaults; an otherwise unmarked TypeScript script requires
    explicit Deno Launch Profile selection. Framework integration still follows
    decision 9, not a blanket replacement by Deno.
18. **Allow schema downloads, not automatic Deno dependency caching.** Deno uses
    prepared project dependencies/cache and reports missing dependencies for
    explicit setup rather than automatic installation. Keep caches private,
    preserve lockfile integrity, and do not create/update project dependency files
    or node_modules. Installed-only Mode remains an acquisition policy, not a
    network sandbox.
19. **No inferred Deno runtime permissions or interactive prompts.** Additional
    scoped permissions require explicit launch configuration. Runtime permissions
    are separate from module/cache operations and do not constrain the native
    language server.
20. **Manage ShellCheck on verified platforms.** Prefer usable External
    Installations; otherwise acquire ShellCheck privately where a native recipe
    is verified. Elsewhere, report ShellCheck diagnostics as unavailable while
    retaining Bash navigation and shfmt formatting. Publish the verified support
    matrix; experimental toolchains or emulation are not required merely to fill
    missing cells.
21. **Include compiled-language debuggers on verified platforms.** Add Delve for
    Go, CodeLLDB for Rust/C++, and NetCoreDbg for .NET, using explicit
    compiled-program or assembly profiles without inferred builds. Required
    runtimes and helpers must be accounted for on every claimed platform, with no
    hidden manual SDK prerequisites or system changes. This reverses the earlier
    debugger exclusions; LLVM lldb-dap is research material, not an additional
    selected adapter.
22. **Honor the application's .NET runtime requirements.** Prefer a compatible
    External Installation; otherwise privately acquire a runtime satisfying the
    compiled application's framework/version and native roll-forward requirements,
    rather than always installing the newest SDK. Self-contained applications use
    their bundled runtime. When managed runtime selection is ambiguous or
    unsupported, require explicit configuration rather than guessing. Do not force
    runtime upgrades, change project metadata, or build the project.

## Existing contract retained

The [managed language tools design](managed-language-tools.md) and
[ADR-0004](../adr/0004-own-language-presets-and-share-managed-installation.md) remain
in force with the compatibility clarification in ADR-0005 and the platform
clarification in ADR-0006:

- Package-owned Language Tool Presets use the shared private installer; protocol
  lifecycle, language routing, formatter selection, and launch policy retain their
  existing owners.
- Automatic acquisition happens on first actual need, including supporting runtimes.
  Latest versions resolve on first installation or explicit Tool Update, not on
  every request. Framework TypeScript SDKs and curated formatter plugins resolve
  latest-compatible dependencies under decisions 9 and 13, rather than forcing an
  incompatible version. .NET Debuggee runtimes follow decision 22's application
  compatibility policy. Failed or cancelled updates retain working selections.
- Explicit Pi configuration and project/PATH External Installations precede Managed
  Installations. Do not modify project dependencies, shell configuration, or the
  user's system installations.
- The shared installer retains native Linux/macOS/Windows x64+ARM64 verification.
  Each preset's declared supported platforms need native acquisition and useful
  operation proofs; declared unsupported platforms need truthful availability
  reporting, not a forced toolchain workaround. OpenCode declarations, artifacts,
  and generic backends alone are not proof. Release gates cover the complete agreed
  catalog and its declared support matrix, not six platforms for every tool.
- Existing explicit-definition suppression, Formatter Marker/conflict handling,
  Installed-only Mode, cancellation, and serialized SDK prefix/coexistence proofs
  remain regression requirements.
- Debugger expansion does not implicitly authorize project builds or arbitrary
  framework/test-runner launch inference.

Vocabulary remains with [Language Tools](../contexts/language-tools/CONTEXT.md) and
the individual package contexts. [Pi LSP](../../packages/pi-lsp/CONTEXT.md) defines
Lint Companion as the complementary server role; that term does not imply that its
presets are implemented. No ownership change has been approved.

## Reference and factual prerequisites

OpenCode was inspected at `43e89ea1673937c325edb922eaa1a768aa0e5bf4` (2026-09-10):

- [LSP catalog](https://github.com/anomalyco/opencode/blob/43e89ea1673937c325edb922eaa1a768aa0e5bf4/packages/opencode/src/lsp/server.ts)
- [Formatter catalog](https://github.com/anomalyco/opencode/blob/43e89ea1673937c325edb922eaa1a768aa0e5bf4/packages/opencode/src/format/formatter.ts)

No DAP catalog was found in that comparison; debugger candidates need separate
primary-source research. Several OpenCode recipes assume existing runtimes or use
project/global installation paths, so they cannot be copied as private acquisition
proof. Framework-server TypeScript SDK requirements must be checked against Pi's
existing TypeScript 7 native LSP choice rather than silently substituting an older
TypeScript toolchain.

Research inputs: [web/configuration compatibility](../research/web-preset-compatibility.md),
[lint companions](../research/lint-companion-presets.md), and
[debugger candidates](../research/dap-preset-candidates.md). Their recommendations
are provisional; they do not override the user's all-at-once delivery choice or
approve any candidate exclusion.

## Implementation outline — one release

The user has confirmed implementation of the accepted product scope and separately
approved the Svelte acquisition security exception on 2026-09-13: allow only
`svelte@4.2.20` to bypass the private installer's publishing-trust comparison,
retaining integrity verification and lifecycle-script denial. The exception is
now enabled for this preset and is not independently digest-bound. The
[security investigation](../research/preset-acquisition-security.md) records the
historical backport evidence and native control boundary.

The following is work order, not permission to release partial batches.

1. **Prove acquisition and platform availability.** Start with the existing private
   installer and native fixtures. Check the current package exports and installed
   Pi APIs, existing mise backends, archive handling, and public installer seams.
   Establish each selected tool's actual private runtime/helper closure and record
   the supported matrix; do not infer support from artifact names alone.
2. **Extend compatible dependency selection only where needed.** Preserve ordinary
   latest selection while supporting the accepted SDK/plugin/runtime constraints.
   Native mise already supports runtime-only .NET installation with exact versions;
   extend the necessary shared version-selection seam rather than add a custom
   backend. Preserve distinct compatible selections, running processes, cancellation,
   and working versions across roots/sessions.
3. **Integrate LSP behavior with its existing owners.** Add the selected definitions,
   project routing, and companion activation. Implement the necessary framework
   SDK/tsserver integration rather than merely installing an SDK. Handle Biome's
   owned daemon lifecycle and push diagnostics, ESLint's required protocol behavior,
   and optional helper paths. Do not introduce a generic plugin registry or replace
   Pi's existing protocol/mutation ownership.
4. **Extend formatter selection and execution.** Add the agreed format mappings and
   conventional tools, compatible curated plugins, and format-capable marker
   filtering. Respect native project configuration and keep lint-only use from
   silently changing formatter choice. Preserve explicit-definition precedence and
   file-scoped mutation handling.
5. **Add the debugger profiles.** Reuse js-debug for Deno; add explicit compiled
   program/assembly profiles for Delve, CodeLLDB, and NetCoreDbg. Preserve existing
   profile/adapter precedence and process ownership. NetCoreDbg does not support
   `runtimeExecutable`; its private host binding must preserve the user's actual
   program/arguments. Let the .NET host enforce compatibility rather than overriding
   roll-forward or building the project.
6. **Complete verification and release documentation.** Apply the requirements below,
   document precise supported platforms and unsupported outcomes, update support
   guidance and Changesets, and deliver the complete catalog together.

### Concrete tool mapping

These are the selected tool identities and initial distribution routes to verify,
not release-pinned versions or completed support claims. Final backend/executable
mappings must follow real installer and protocol evidence.

| Area                                | Tool identity / integration                                                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Vue LSP                             | `@vue/language-server`, compatible TypeScript SDK/tsserver host, and `@vue/typescript-plugin` integration                      |
| Svelte LSP                          | `svelte-language-server` with compatible SDK and project integration                                                           |
| Astro LSP                           | `@astrojs/language-server` with compatible SDK and project integration                                                         |
| Deno LSP                            | Deno's `lsp` command, selected by Deno project configuration                                                                   |
| HTML, CSS/SCSS/LESS, JSON/JSONC LSP | The corresponding VS Code-derived servers; verify the `vscode-langservers-extracted` distribution and current service behavior |
| YAML LSP                            | `yaml-language-server`                                                                                                         |
| Bash LSP                            | `bash-language-server`, resolved ShellCheck and shfmt helpers where available                                                  |
| Dockerfile LSP                      | `dockerfile-language-server-nodejs`                                                                                            |
| Terraform LSP                       | `terraform-ls` from the official HashiCorp distribution                                                                        |
| Lint Companions                     | Official ESLint extension server artifact, Biome `lsp-proxy`, and Oxlint `--lsp`; opt-in `oxlint-tsgolint` helper              |
| Web/configuration formatting        | Existing Prettier/Biome identities with the accepted additional file mappings                                                  |
| Framework formatting                | Prettier core for Vue; `prettier-plugin-svelte` and `prettier-plugin-astro` for the other selected frameworks                  |
| Conventional/new formatting         | Maintained `mvdan/sh` shfmt, Terraform CLI `fmt`, and Deno `fmt`                                                               |
| Deno debugging                      | Existing `vscode-js-debug` adapter plus the selected Deno runtime                                                              |
| Go debugging                        | Delve `dlv dap`, launching an already compiled program                                                                         |
| Rust/C++ debugging                  | CodeLLDB platform package, including its required LLDB/helper closure                                                          |
| .NET debugging                      | NetCoreDbg plus a compatible host/runtime where required by the compiled application                                           |

### Verification targets, not support promises

Try the ordinary portable/native acquisition paths on the six installer platforms.
For platform-specific tools, start with their published platform packages and
straightforward private source paths. ShellCheck's Windows packaging needs actual
architecture validation; Delve's macOS helper, CodeLLDB's bundled dependencies,
and NetCoreDbg's runtime closure need explicit proofs. Missing Windows ARM64
artifacts or macOS x64 packages do not force experimental builds or exclude the
whole tool. Publish only the matrix established by those proofs.

Deno exposes cache-on-save, CLI cached-only/frozen/module-directory controls, and
scoped permissions; do not invent an LSP cached-only flag, CLI cache-dir flag, or
Pi preset-settings overlay. The exact no-write behavior still needs native tests,
including projects requesting automatic node_modules/vendor management. .NET
runtime-only acquisition and launch likewise need actual isolation tests, not an
assumption that installer-private environment variables reach the Debuggee.

If evidence requires a catalog or policy change, return to the user instead of
silently dropping a selected tool or weakening a claimed guarantee.

## Verification requirements

These apply the accepted scope and retained contract; they are not completed tests.

- **Installer:** retain native Linux/macOS/Windows x64+ARM64 acquisition, isolation,
  coordination, update, interruption, and cancellation checks at the shared public
  seams. Status/discovery must not trigger installations.
- **Preset support matrix:** record exact tool/runtime versions, OS baselines, and
  real acquisition plus useful operations for every claimed supported cell. Test
  truthful unavailable outcomes and compatible external precedence elsewhere. Do
  not turn an unresolved implementation bug or transient download failure into a
  claimed upstream platform limitation.
- **LSP:** exercise plain TS7, framework-compatible SDK/integration paths, and Deno
  selection; project-declared companion coexistence and enablement; missing project
  libraries; push/pull diagnostic freshness and truthful unavailable outcomes;
  command-bearing actions and guarded previews/apply. Bash missing-helper outcomes
  must not look like clean diagnostics or successful formatting.
- **Formatting:** cover the new file mappings, nearest eligible markers, conflicts,
  conventional selections, Deno's explicit formatter declaration, compatible plugin
  loading, ignored files, and exclusion of experimental builtin routes. Verify no
  dependency/configuration changes accompany acquisition or formatting setup.
- **Debugging:** verify direct Deno and explicit compiled-program/assembly profiles,
  breakpoints/source maps or symbols, stack/variables/evaluate, execution control,
  failed startup, stop, cancellation, and process cleanup. Test runtime/profile
  precedence and prove that defaults do not build projects or infer permissions.
- **Deno safeguards:** test prepared and missing dependencies, frozen lockfile
  behavior, private caches, and configurations requesting automatic node_modules
  or vendor management. Native controls must prove the no-write contract or fail
  clearly without changing project dependencies.
- **Coexistence and caching:** compare ordered serialized tool definitions, system
  prompt, and affected message-history prefixes in offline SDK tests before and
  after first use, updates, and supported/unavailable outcomes. Include standalone
  and combined LSP/Formatter/DAP modes and root/child installation concurrency.
- **Release:** run the repository's applicable verification and package/Git-install
  gates, provide Changesets for every releasable package change, and ship only the
  complete selected catalog with its verified support matrix.
