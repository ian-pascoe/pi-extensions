# Web and configuration Language Tool compatibility

Research-only note for the curated OpenCode-inspired preset expansion. OpenCode reference: `.repos/opencode` `43e89ea1673937c325edb922eaa1a768aa0e5bf4` (2026-09-10); its recipes are comparison material, not proof of Pi Managed Installation support. No language tools were installed or executed for this note.

The user subsequently chose one complete release of the agreed catalog, not staged
cohorts. Research recommendations below are investigation priorities, not approved
deferrals or delivery phases; the [design plan](../plans/language-tool-preset-expansion.md)
is the scope authority. The follow-up section supersedes the initial HashiCorp
asset uncertainty and clarifies shfmt's potential source-build path. The user has
also accepted private latest-compatible framework TypeScript SDKs and the necessary
integration ([ADR-0005](../adr/0005-isolate-framework-typescript-compatibility.md));
the initial TS7-only deferral recommendations below do not apply to that accepted
compatibility path. The agreed catalog is recorded in the plan; native proof
remains outstanding. The later [platform clarification](../adr/0006-separate-installer-and-preset-platform-support.md)
requires six-platform installer support but permits documented per-preset subsets.
Earlier six-cell gap assessments below are not automatic preset exclusions.

## Decision-critical result: TypeScript 7 is not a drop-in base for framework servers

Pi's current TypeScript preset intentionally launches TypeScript 7's native LSP (`tsc --lsp --stdio`). The TypeScript research note proves that recipe and its six npm platform packages, but TypeScript 7's compatibility boundary matters for framework servers.

- **Vue: defer as a TS7-based preset.** Current npm metadata is `@vue/language-server@3.3.11`; its executable is `vue-language-server`, and its README says `--tsdk` points at a TypeScript `lib` directory. The same README says the server collaborates with `@vue/typescript-plugin` through custom `tsserver/request` and `tsserver/response` notifications. The plugin README explicitly describes a TypeScript language-service plugin for `tsserver`, including `tsconfig` `plugins` and custom commands. Vue's upstream TypeScript 7 issue is closed; a Vue maintainer says `tsgo` does not currently provide customization/plugins, while another maintainer's discussion describes switching Vue projects back to TypeScript 5 with Volar. TypeScript 7's standard LSP therefore cannot be assumed to power Vue files. A future Vue preset needs a separately verified TypeScript 5/6 private runtime and a Pi launch/configuration design; do not silently replace the current TS7 preset or mutate project `tsconfig`.
- **Svelte: defer as a TS7-based preset.** Current npm metadata is `svelte-language-server@0.18.4`, executable `svelteserver`; its peer dependency is `typescript: ^5.9.2 || ^6.0.2`, not TypeScript 7. Its README describes TypeScript/JavaScript support through a TypeScript plugin plus Svelte, HTML, and CSS plugins. This is a direct compatibility signal, not merely a version guess. A managed Svelte preset needs an older TypeScript runtime and six-cell probes before shipping; its Prettier integration also has a separate plugin dependency.
- **Astro: defer.** Current npm metadata is `@astrojs/language-server@2.16.16`, executable `astro-ls`; its package declares `volar-service-typescript` and requires `prettier` plus `prettier-plugin-astro` as optional peers for formatting. The primary `nodeServer.ts` requires `initializationOptions.typescript.tsdk` and calls Volar's `loadTsdkByPath`, requiring a directory containing `typescript.js` or `tsserverlibrary.js`; it is not compatible with Pi's TypeScript 7 native-only `tsc` layout without a separate compatibility path. The server also discovers Astro in the project and loads project Vue/Svelte integrations. Keep Astro out of the first TS7-only cohort.

Primary sources: [TypeScript 7 research](./typescript-7-native-lsp.md), [Vue language-server README](https://raw.githubusercontent.com/vuejs/language-tools/master/packages/language-server/README.md), [Vue TypeScript plugin README](https://raw.githubusercontent.com/vuejs/language-tools/master/packages/typescript-plugin/README.md), [Vue TS7 issue](https://github.com/vuejs/language-tools/issues/5381) and [comments](https://api.github.com/repos/vuejs/language-tools/issues/5381/comments), [Svelte README](https://raw.githubusercontent.com/sveltejs/language-tools/master/packages/language-server/README.md), [Svelte npm metadata](https://registry.npmjs.org/svelte-language-server/latest), [Astro node server](https://raw.githubusercontent.com/withastro/language-tools/main/packages/language-server/src/nodeServer.ts), [Astro language plugins](https://raw.githubusercontent.com/withastro/language-tools/main/packages/language-server/src/languageServerPlugin.ts), [Astro npm metadata](https://registry.npmjs.org/@astrojs/language-server/latest).

## Straightforward LSP candidates

These do not depend on TypeScript's compiler/plugin API and are better first candidates, but each still needs Pi's native Linux/macOS/Windows x64+ARM64 acquisition and protocol probes. The npm version or a generic mise selector is not platform evidence.

| Candidate     | Current identity / source fact                                                                                                                                                       | Pi-specific constraints and unknowns                                                                                                                                                                                                                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| YAML          | `yaml-language-server@1.24.0`, bin `yaml-language-server`, `--stdio`; Red Hat project. Supports validation, completion, hover, symbols, formatting, and JSON-Schema associations.    | Node server; npm metadata has no explicit `engines` field (README development prerequisite says Node >=18). SchemaStore/remote-schema access needs a deliberate network policy and tests. Exact six-cell launch/protocol behavior and managed npm selector are **UNKNOWN**.                                                            |
| Bash/sh       | `bash-language-server@5.6.0`, bin `bash-language-server`, command `start`; Node engine >=16. It provides diagnostics, symbols, completion, references, rename, and formatting hooks. | ShellCheck and shfmt are optional external dependencies of the server, not bundled. Do not promise private ShellCheck: official ShellCheck binaries listed by its README lack Apple Silicon and native Windows ARM assets. `bash-language-server` itself needs six-cell probes; ShellCheck/shfmt behavior must be reported separately. |
| HTML/CSS/JSON | `vscode-langservers-extracted@4.10.0` exposes `vscode-html-language-server`, `vscode-css-language-server`, and `vscode-json-language-server` bins.                                   | Maintained package metadata is old (published 2024) and depends on TypeScript `^4.0.5`; that dependency is internal to the extracted servers, not proof of TS7 interoperability, but it is a maintenance risk. Verify actual LSP startup and document requests on all six cells before making presets.                                 |
| Dockerfile    | `dockerfile-language-server-nodejs@0.15.0`, bin `docker-langserver`; npm package depends on `dockerfile-language-service@0.16.1`.                                                    | Package is old (latest npm metadata has a 2025 package publish but upstream GitHub release history is old); no current six-platform/runtime proof. Treat as lower priority or external-only until maintenance and launch probes are resolved.                                                                                          |
| Terraform     | Official HashiCorp `terraform-ls`, current GitHub release `v0.39.0` (2026-07-23); distributed as a single binary and supports formatting among other LSP methods.                    | Release API exposed no assets in this query; exact six-cell asset names/checksums and managed selector are **UNKNOWN**. It likely needs a GitHub/archive acquisition mapping, not npm. Terraform CLI's `terraform fmt` is separate from `terraform-ls`; neither is currently proven in `pi-tool-installer`.                            |

Sources: [YAML README](https://raw.githubusercontent.com/redhat-developer/yaml-language-server/main/README.md), [YAML npm metadata](https://registry.npmjs.org/yaml-language-server/latest), [Bash README](https://raw.githubusercontent.com/bash-lsp/bash-language-server/main/README.md), [Bash npm metadata](https://registry.npmjs.org/bash-language-server/latest), [HTML/CSS/JSON npm metadata](https://registry.npmjs.org/vscode-langservers-extracted/latest), [Dockerfile npm metadata](https://registry.npmjs.org/dockerfile-language-server-nodejs/latest), [Terraform README](https://raw.githubusercontent.com/hashicorp/terraform-ls/main/README.md), [Terraform installation](https://raw.githubusercontent.com/hashicorp/terraform-ls/main/docs/installation.md), [Terraform release v0.39.0](https://api.github.com/repos/hashicorp/terraform-ls/releases/latest), [ShellCheck installation/platform list](https://raw.githubusercontent.com/koalaman/shellcheck/master/README.md).

## Formatter implications

- Keep **Prettier** and **Biome** as project-marker-selected web formatters. They are already managed and six-cell verified in Pi. Do not make generic `package.json` or a file extension select them; the existing Formatter Marker policy is correct.
- **Svelte and Astro formatting are plugin-dependent.** Svelte's server documents `prettier-plugin-svelte`; Astro's server declares `prettier` and `prettier-plugin-astro` peers and loads them from the project. A standalone Pi Formatter preset would need explicit, reviewed plugin acquisition and a project-compatible configuration model. Do not claim that managed Prettier alone formats `.svelte` or `.astro` correctly.
- **YAML:** `yaml-language-server` itself provides LSP formatting, but Pi Formatter is an executable formatter path rather than an LSP-formatting proxy. The conservative first choice is Prettier only when a Prettier marker exists; adding a managed YAML formatter requires a separate decision and probe.
- **Shell:** use `shfmt` for formatting, not the abandoned npm package `shfmt@0.0.1`. The maintained upstream is `mvdan/sh`; current release `v3.14.1` (2026-09-06) publishes native macOS x64/ARM64, Linux x64/ARM64, and Windows x64 binaries, but no Windows ARM64 asset in the release API. This fails the current six-platform Managed Installation gate unless Windows ARM is built/proven or the preset is external-only. `shfmt` honors EditorConfig and supports `-w`; formatter marker/activation policy still needs design.
- **Terraform:** `terraform fmt` is the relevant formatter identity, distinct from `terraform-ls`; it requires Terraform CLI. Managed Terraform CLI acquisition and six-cell coverage are **UNKNOWN** and must not be inferred from Terraform language-server availability.

Sources: [Svelte README](https://raw.githubusercontent.com/sveltejs/language-tools/master/packages/language-server/README.md), [Astro README](https://raw.githubusercontent.com/withastro/language-tools/main/packages/language-server/README.md), [Astro language-service plugin](https://raw.githubusercontent.com/withastro/language-tools/main/packages/language-server/src/languageServerPlugin.ts), [shfmt README](https://raw.githubusercontent.com/mvdan/sh/master/README.md), [shfmt manpage](https://raw.githubusercontent.com/mvdan/sh/master/cmd/shfmt/shfmt.1.scd), [shfmt release/assets](https://api.github.com/repos/mvdan/sh/releases/latest).

## DAP scope

OpenCode's referenced catalog files contain no DAP catalog. These LSP/formatter sources do not justify adding Java, .NET, Go, Ruby, or other adapters. Existing Pi JavaScript and Python direct-script adapters remain the only researched defaults; each new DAP Adapter Definition needs independent primary-source research, launch semantics, and the same six-cell native proof.

## Follow-up: source-built shfmt and HashiCorp distributions

### shfmt source build is plausible, not yet proven

The upstream project's official install command is `go install mvdan.cc/sh/v3/cmd/shfmt@latest`. The module currently declares `go 1.26.0`; `cmd/shfmt/main.go` has no build constraints and imports ordinary Go modules (`github.com/google/renameio/v2`, `github.com/rogpeppe/go-internal/diff`, `golang.org/x/term`, `mvdan.cc/editorconfig`, and the module's own packages). The module's direct and indirect dependencies are recorded in its `go.mod`; this is a source build, not a prebuilt-artifact fallback. Pi already has a privately managed Go 1.27.1 runtime, so a native source build on each supported runner is technically plausible, including Windows ARM64 if Go's native toolchain and dependency build succeed there.

The supported upstream identity is the Go module command path `mvdan.cc/sh/v3/cmd/shfmt`; `go:mvdan.cc/sh/v3/cmd/shfmt` is only a **hypothesis** for the installer's Go backend and has not been validated by mise or Pi. Unknowns are whether mise's `go:` backend accepts arbitrary command-module paths, how it publishes the resulting binary and environment, build time/cancellation behavior, and whether a native Go 1.27.1 build succeeds on all six cells. Missing Windows ARM64 release assets therefore do **not** prove shfmt is unsupported; six-cell source-build evidence is still required.

Sources: [upstream go.mod](https://raw.githubusercontent.com/mvdan/sh/master/go.mod), [upstream cmd/shfmt/main.go](https://raw.githubusercontent.com/mvdan/sh/master/cmd/shfmt/main.go), [upstream install instructions](https://raw.githubusercontent.com/mvdan/sh/master/README.md), [Pi managed Go baseline](../../packages/pi-tool-installer/README.md#verified-baselines).

### Terraform distributions have a six-cell official matrix

HashiCorp's official release index lists `terraform-ls_0.39.0`; its release directory contains SHA256 sums/signatures and these relevant native archives: `darwin_amd64`, `darwin_arm64`, `linux_amd64`, `linux_arm64`, `windows_amd64`, and `windows_arm64` (plus other architectures). Thus Terraform LS has an official six-cell archive matrix, unlike the earlier GitHub API result with no assets. HashiCorp's installation guide says it is a single binary and directs users to the releases site and checksums.

Terraform CLI's official `1.16.2` directory likewise contains SHA256 sums/signatures and `darwin_amd64`, `darwin_arm64`, `linux_amd64`, `linux_arm64`, `windows_amd64`, and `windows_arm64` archives. `terraform fmt` belongs to this CLI, not `terraform-ls`. The exact managed acquisition mapping, checksum verification path, command arguments, and whether Pi should acquire the CLI solely for formatting remain **UNKNOWN**; these release pages establish distribution availability, not Pi support.

Sources: [terraform-ls versions](https://releases.hashicorp.com/terraform-ls/), [terraform-ls 0.39.0 files](https://releases.hashicorp.com/terraform-ls/0.39.0/), [HashiCorp installation guide](https://raw.githubusercontent.com/hashicorp/terraform-ls/main/docs/installation.md), [Terraform versions](https://releases.hashicorp.com/terraform/), [Terraform 1.16.2 files](https://releases.hashicorp.com/terraform/1.16.2/).

### Framework runtime/bridge clarification

Installing TypeScript 5/6 beside TypeScript 7 would not by itself make Vue work. Vue's server/plugin arrangement needs a TypeScript language-service (`tsserver`) host, the Vue plugin registration from project `tsconfig` or equivalent, Volar's custom `tsserver/request` and `tsserver/response` bridge, and a command/environment that points the server at the compatible SDK. Pi's current client starts one standard LSP process and does not implement that tsserver plugin bridge. Whether a standalone Vue server can encapsulate the bridge without project dependencies is **UNKNOWN** and needs a focused prototype; simply adding a `core:node` + `npm:typescript` requirement is insufficient.

Svelte's npm package bundles its server and many language-service dependencies, but its TypeScript integration is a peer/runtime concern (`typescript: ^5.9.2 || ^6.0.2`), and its README describes project/editor TypeScript configuration. It is not proven self-contained with respect to a TypeScript SDK or project `svelte.config`/tsconfig. Astro is more explicit: its node server requires a `typescript.tsdk` initialization option pointing to `typescript.js` or `tsserverlibrary.js`, discovers Astro from the workspace, and dynamically loads project `@astrojs/vue`/`@astrojs/svelte` integrations; its formatting path loads project `prettier` and `prettier-plugin-astro`. Thus Svelte and Astro cannot be treated as purely self-contained managed npm servers without testing the project dependency boundary and defining whether Pi may acquire those dependencies privately.

Sources: [Vue server README](https://raw.githubusercontent.com/vuejs/language-tools/master/packages/language-server/README.md), [Vue plugin README](https://raw.githubusercontent.com/vuejs/language-tools/master/packages/typescript-plugin/README.md), [Svelte npm metadata](https://registry.npmjs.org/svelte-language-server/latest), [Svelte README](https://raw.githubusercontent.com/sveltejs/language-tools/master/packages/language-server/README.md), [Astro node server](https://raw.githubusercontent.com/withastro/language-tools/main/packages/language-server/src/nodeServer.ts), [Astro import/package integration](https://raw.githubusercontent.com/withastro/language-tools/main/packages/language-server/src/importPackage.ts), [Astro language plugins](https://raw.githubusercontent.com/withastro/language-tools/main/packages/language-server/src/languageServerPlugin.ts).

## Follow-up: exact formatter coverage

Checked against primary documentation and package metadata on 2026-09-11. These
are upstream capability facts, not adopted Pi file mappings or six-cell proof.
Existing Pi Formatter automatic presets currently route only JS/TS, Python, Go,
and Rust; upstream support alone does not enable additional Pi routing.

| Tool           | Stable coverage relevant to this expansion                                                        | Extra dependencies or non-stable modes                                                                                                                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prettier 3.9.6 | Core parsers for HTML, CSS, SCSS, LESS, JSON, JSONC, JSON5, YAML, Markdown, MDX, GraphQL, and Vue | Svelte needs `prettier-plugin-svelte`; Astro needs `prettier-plugin-astro`. Prettier 3 requires explicit plugin loading. Vue does not need an extra plugin.                                                                                  |
| Biome 2.5.13   | JSON, JSONC, CSS, and GraphQL, alongside existing JS/TS                                           | HTML formatting is experimental and explicitly enabled; Vue/Svelte/Astro additionally require experimental full support. The official matrix still marks SCSS, YAML, and Markdown in progress. Do not infer support for LESS, JSON5, or MDX. |
| Deno fmt       | JS/TS/JSX/TSX, Markdown, JSON/JSONC, HTML, CSS/SCSS/LESS, and YAML                                | Vue/Svelte/Astro remain behind the unstable component-formatting option. GraphQL, JSON5, and MDX are not listed. No Prettier plugins are involved.                                                                                           |

The Svelte plugin's current 4.1.1 release requires Prettier `^3.0.0`, Svelte
`^5.0.0`, and Node >=20; its v3 line supports Svelte 4. Astro plugin 1.0.0 requires
Prettier `^3.5.3` and Node >=22.12.0. Consequently, blindly installing the newest
plugin beside any project formatter/framework version is not a compatibility
policy. Plugin ownership, matching, and loading still need design and probes.

Biome's changelog includes work on SCSS/YAML/Markdown, but that does not supersede
the official support matrix's in-progress status. Framework embedded-language
support also does not establish standalone support for other file types. Do not
silently enable experimental HTML/framework or embedded-snippet settings.

Deno's current formatter documentation has inconsistent trailing prose about
unstable HTML/CSS/SCSS/LESS/YAML flags. Its format table, current source dispatch,
and the Deno 2.0 stabilization PR establish these as stable; component formatting
remains unstable. Deno reads project formatting configuration and EditorConfig.
The exact release recipe, private caches, selection rules, and no-project-write
behavior still need Pi tests.

Sources: [Prettier parsers](https://prettier.io/docs/options),
[plugins and loading](https://prettier.io/docs/plugins),
[Prettier package](https://registry.npmjs.org/prettier/3.9.6),
[Svelte plugin](https://github.com/sveltejs/prettier-plugin-svelte),
[Svelte plugin metadata](https://registry.npmjs.org/prettier-plugin-svelte/4.1.1),
[Astro plugin](https://github.com/withastro/prettier-plugin-astro),
[Astro plugin metadata](https://registry.npmjs.org/prettier-plugin-astro/1.0.0),
[Biome support matrix](https://biomejs.dev/internals/language-support/),
[Biome configuration](https://biomejs.dev/reference/configuration/),
[Biome release](https://github.com/biomejs/biome/releases/tag/@biomejs%2Fbiome@2.5.13),
[Deno fmt](https://docs.deno.com/runtime/reference/cli/fmt/),
[Deno formatter source](https://raw.githubusercontent.com/denoland/deno/main/cli/tools/fmt.rs),
[Deno 2.0 stabilization](https://github.com/denoland/deno/pull/25753).

## Follow-up: Bash optional helpers and truthful diagnostics

Bash language server 5.6.0 retains Tree-sitter parsing, navigation, symbols,
completion, and rename without ShellCheck, but **does not publish parser syntax
errors as LSP diagnostics** in that release. Its syntax-error branch logs a
warning. Source-command errors can produce Information diagnostics only when
`enableSourceErrorDiagnostics` is enabled. ShellCheck absence disables linting
with a `window/logMessage` warning, not an error diagnostic; this must not be
presented as a clean lint result.

The server accepts an absolute `bashIde.shfmt.path` and passes it to the formatter
process unchanged. It statically advertises formatting even when shfmt is absent
or disabled; absence logs a warning and returns an empty edit list. Thus the
advertised capability alone is not proof that formatting worked. Since shfmt is
in the accepted catalog, integration should use its resolved executable through
the existing owners rather than install a duplicate or rely on an unchanged user
PATH. The user has now accepted managed ShellCheck on verified platforms,
with external precedence and explicit diagnostic unavailability elsewhere; the
exact supported matrix is still unproven.

ShellCheck's v0.11.0 release API includes native macOS ARM64/x64 and Linux ARM64/x64
assets, correcting the earlier README-based Apple Silicon uncertainty. Its generic
Windows zip is described by the tagged README as Windows x86; there is no verified
Windows ARM64 archive. Official `cabal install` instructions establish a Haskell
source-build route, not a private six-platform proof. Missing release assets do not
prove a source build impossible. ShellCheck is GPL-3 licensed.

Sources at Bash release commit `2fb9b33b6f40b508bf3b54233ff4efef0cb08206`:
[capabilities and requests](https://raw.githubusercontent.com/bash-lsp/bash-language-server/2fb9b33b6f40b508bf3b54233ff4efef0cb08206/server/src/server.ts),
[configuration](https://raw.githubusercontent.com/bash-lsp/bash-language-server/2fb9b33b6f40b508bf3b54233ff4efef0cb08206/server/src/config.ts),
[ShellCheck handling](https://raw.githubusercontent.com/bash-lsp/bash-language-server/2fb9b33b6f40b508bf3b54233ff4efef0cb08206/server/src/shellcheck/index.ts),
[shfmt handling](https://raw.githubusercontent.com/bash-lsp/bash-language-server/2fb9b33b6f40b508bf3b54233ff4efef0cb08206/server/src/shfmt/index.ts),
[analyzer](https://raw.githubusercontent.com/bash-lsp/bash-language-server/2fb9b33b6f40b508bf3b54233ff4efef0cb08206/server/src/analyser.ts),
[protocol logging](https://raw.githubusercontent.com/bash-lsp/bash-language-server/2fb9b33b6f40b508bf3b54233ff4efef0cb08206/server/src/util/logger.ts).
ShellCheck: [release assets](https://api.github.com/repos/koalaman/shellcheck/releases/237202770),
[tagged installation/source-build instructions](https://raw.githubusercontent.com/koalaman/shellcheck/v0.11.0/README.md).

## Remaining investigation areas

1. **LSP acquisition and behavior:** verify each selected server's maintenance,
   private acquisition, and useful protocol behavior on all six native targets.
2. **Framework integration:** implement and prove the accepted compatible-SDK path
   only after the design is confirmed; do not route frameworks through native TS7
   by assumption or change project dependencies.
3. **Formatting:** prove shfmt's private Go build, Terraform CLI mapping, additional
   file routing, and compatible Svelte/Astro plugin delivery for selected presets.
4. **Debugging:** use the separate [DAP research](dap-preset-candidates.md), including
   Deno adapter reuse; OpenCode's LSP catalog does not establish debugger support.

## Explicit unknowns

- No new candidate has Pi's six-platform native acquisition/protocol evidence.
- Mise selector/back-end support for each new tool, especially Terraform, shfmt, Dockerfile, and any old npm package, is unverified.
- The exact Pi settings needed for YAML schema associations, SchemaStore network access, Bash ShellCheck/shfmt integration, and framework project dependency discovery are unchosen.
- TypeScript 5/6 coexistence with Pi's TypeScript 7 preset, including cross-file routing and cache-prefix effects, needs an offline SDK proof before implementation.
- No new DAP adapter has been selected or validated.
