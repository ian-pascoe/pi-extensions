# @ian-pascoe/pi-formatter

Project-aware post-edit formatting for [Pi](https://github.com/earendil-works/pi).

## Install

```bash
pi install npm:@ian-pascoe/pi-formatter
# or
pi install git:github.com/ian-pascoe/pi-extensions
```

For a local checkout, run `pi -e ./packages/pi-formatter/src/index.ts` after installing workspace
dependencies and building `pi-tool-installer`. No separate mise installation is needed.

## Built-in formatters

| Preset ID   | Files                                                                                       | Selection                                         | Invocation                                                                       |
| ----------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------- |
| `prettier`  | JS/TS; HTML, CSS/SCSS/LESS; JSON/JSONC/JSON5; YAML; Markdown/MDX; GraphQL; Vue/Svelte/Astro | Nearest eligible Prettier Marker                  | CLI for core/Vue; selected Prettier API plus compatible plugins for Svelte/Astro |
| `biome`     | JS/TS, JSON/JSONC, CSS, GraphQL                                                             | Nearest eligible Biome Marker                     | `biome format --write FILE`                                                      |
| `black`     | `.py`, `.pyi`                                                                               | Nearest Black Marker                              | `black FILE`                                                                     |
| `ruff`      | `.py`, `.pyi`                                                                               | Nearest Ruff Marker                               | `ruff format FILE`                                                               |
| `gofmt`     | `.go`                                                                                       | Conventional default                              | `gofmt -w FILE`                                                                  |
| `rustfmt`   | `.rs`                                                                                       | Conventional default                              | `rustfmt [--edition EDITION] --config skip_children=true FILE`                   |
| `shfmt`     | `.sh`, `.bash`, `.bats`                                                                     | Conventional default                              | `shfmt -w FILE`                                                                  |
| `terraform` | `.tf`, `.tfvars`                                                                            | Conventional default                              | `terraform fmt FILE`                                                             |
| `deno`      | JS/TS, Markdown, JSON/JSONC, HTML, CSS/SCSS/LESS, YAML                                      | Explicit `fmt` declaration in nearest Deno config | `deno fmt FILE`                                                                  |

Web/configuration/framework and Python files with **no declared formatter preference are left alone**. Experimental Biome HTML/framework modes and Deno component formatting are not builtin routes. A generic
`package.json` or `pyproject.toml` is not a Formatter Marker. Discovery walks from the changed
file toward the filesystem root, selecting the nearest directory with a preference, including
nested monorepo packages. Marker files and manifest declarations are reread on each mutation.

Recognized Formatter Markers:

- **Prettier:** `.prettierrc`; `.prettierrc.{json,json5,yml,yaml,toml,js,cjs,mjs,ts,cts,mts}`;
  `prettier.config.{js,cjs,mjs,ts,cts,mts}`; a `package.json` `prettier` configuration object/string;
  or a `prettier` entry in `dependencies` or `devDependencies`.
- **Biome:** `biome.json`, `biome.jsonc`, or `@biomejs/biome` in `package.json` `dependencies` or
  `devDependencies`. A native `formatter.enabled: false` or language-specific formatter disablement excludes that candidate for the file; lint-only use does not select formatting.
- **Deno:** a parsed `fmt` object in `deno.json` or `deno.jsonc`. A runtime-only config, including one that declares imports/tasks, is not a Formatter Marker.
- **Black:** a parsed `pyproject.toml` `[tool.black]` table or a Black dependency declaration.
- **Ruff:** `ruff.toml`, `.ruff.toml`, a parsed `[tool.ruff]` table, or a Ruff dependency declaration.
- Python dependency declarations include PEP 621 `project.dependencies` and
  `project.optional-dependencies`, PEP 735 `dependency-groups`, `tool.uv.dev-dependencies`, and
  Poetry `dependencies`, `dev-dependencies`, and group dependencies. Distribution names are
  parsed; mentions in descriptions, comments, URLs, or unrelated settings do not select a tool.

Only format-capable candidates compete: a Biome marker cannot hide or conflict with Prettier for Markdown, SCSS, or a framework component. The nearest directory with an eligible candidate owns selection. Conflicting eligible alternatives at the same directory warn and leave the file unchanged. For example,
using Ruff for linting and Black for formatting requires an explicit Black Formatter Definition.
Malformed relevant manifests produce a warning instead of a guessed selection. Formatter configs
remain owned by the formatter itself; marker discovery does not execute JS/TS configuration files.

**Biome eligibility:** the selected CLI checks the file without writing, using `format --reporter=json --no-errors-on-unmatched`. Biome owns inheritance, per-file overrides, language enablement, and ignores; disabled or ignored files do not compete with another formatter. Formatting differences and parse diagnostics still establish an enabled candidate. Acquisition, timeout, cancellation, invalid configuration, and malformed or unsuccessful reports do not count as disablement: Pi warns without selecting a competitor. This uses Biome's experimental JSON reporter (verified with 2.5.13), fails closed if its report changes, and starts no daemon. An Explicit Definition bypasses candidate discovery and retains native configuration.

Rust uses the nearest `Cargo.toml` package edition, including `edition.workspace = true` and
`package.workspace` locations. A native `rustfmt.toml`/`.rustfmt.toml` edition takes precedence.
Without an edition declaration, rustfmt keeps its native default. Pi invokes rustfmt on the changed
file with `--config skip_children=true`, not `cargo fmt`, so out-of-line sibling modules
are not rewritten. Other native formatter configuration still applies.

shfmt honors EditorConfig; Terraform formatting does not run `init` or build a project.
Deno formatting uses a private `DENO_DIR`, disables update checks/prompts, and does not prepare imports, dependencies, node_modules, vendor directories, or lockfiles. Known npm/pnpm launchers are resolved read-only to an existing native payload rather than executed: incomplete payloads yield to later external candidates or private acquisition (an unavailable error with downloads disabled). Formatting is not Deno runtime execution and grants no runtime permissions.

### Curated framework plugins

Svelte and Astro use the **same selected Prettier installation**, with compatible project plugins preferred over private copies. The managed fallback resolves the latest stable plugin compatible with that Prettier, the selected Node runtime, and the installed framework version or declared dependency range. It never upgrades project dependencies or replaces an external formatter. An unsupported or ambiguous combination reports a recovery error instead of guessing.

The runner uses Prettier's native configuration, EditorConfig, and ignore APIs for components and ordinary files alike. Mixed configurations support both plugin-name strings and direct JS/TS config imports. Native Node resolution hooks redirect only the exact curated `prettier-plugin-svelte` / `prettier-plugin-astro` names to compatible project or private copies; other imports/plugins remain project-owned and are never downloaded. Ignored files skip configuration loading and plugin acquisition. Without native resolution hooks, successfully resolved opaque plugin objects alone retain ordinary CLI ownership; the runner does not guess their identity. A Svelte/Astro file extension or native configuration's literal `svelte`/`astro` parser still selects authoritative framework compatibility handling.

The helper needs Node's native `module.registerHooks` (22.15+/23.5+, checked at runtime). When the selected Node lacks it, the runner reuses a compatible Pi or managed Node, or acquires a separate private Node helper when automatic installation is enabled. Acquisition selects the latest stable Node compatible with Prettier's declared engines and the hook API; existing formatter receipts are not replaced. Installed-only mode reuses available helpers without downloading. In every case, the selected Prettier module is unchanged, plugin compatibility is checked against the actual runtime, and ordinary CLI execution without curated plugins keeps its original runtime. Opaque PATH wrappers retain ownership for ordinary files; framework components need a discoverable Prettier module or an Explicit Definition. Unusually long compatibility declarations that cannot fit a managed receipt identity also need a project plugin or an Explicit Definition.

## Settings and explicit choices

Pi Formatter reads the `formatter` key from Pi's global `~/.pi/agent/settings.json` and trusted
project `.pi/settings.json`:

```json
{
  "formatter": {
    "autoInstall": true,
    "timeoutMs": 30000,
    "formatters": {
      "markdownlint-cli2": {
        "command": "markdownlint-cli2",
        "args": ["--fix", "$FILE"],
        "files": { "extensions": [".md", ".mdx"], "fileNames": ["README"] },
        "requireRootMarker": true,
        "rootMarkers": ["package.json", ".git"],
        "environment": {}
      },
      "rustfmt": null
    }
  }
}
```

`autoInstall` defaults to `true`. Set it to `false` for **Installed-only Mode**: project-local,
PATH, and existing Managed Installations remain usable without acquiring a helper or refreshing
registries. Missing tools/prerequisites warn with recovery instructions. Explicit updates are
still deliberate network actions; this setting is not a network sandbox.

Explicit matching definitions suppress automatic defaults **even under different IDs**, including
when their Activation Gate skips execution or their command fails. Explicit multi-formatter chains
still run in declaration order. There is no fallback after an explicit command failure.
A definition, `null`, or invalid entry under a built-in ID shadows that built-in.

For an explicit Python formatting choice:

```json
{
  "formatter": {
    "formatters": {
      "python-style": {
        "command": "black",
        "args": ["$FILE"],
        "files": { "extensions": [".py", ".pyi"] },
        "rootMarkers": ["pyproject.toml"]
      }
    }
  }
}
```

Explicit commands are user-owned: install their executables separately. Each definition requires a
non-empty `command` and at least one extension (including its leading period) or exact basename.
Matching is case-sensitive. Arguments are passed as argv; shell pipelines and expansions are not
interpreted. Windows executable shims use `cross-spawn`. Every `$FILE` substring is replaced with
the absolute changed-file path. Environment values override the child environment; `null` removes
a variable.

A File Formatter using `$FILE` runs once per matching changed file. A Workspace Formatter without
`$FILE` runs once per matching workspace root. `rootMarkers` are basename glob patterns; the
nearest matching ancestor becomes the command working directory, otherwise Pi's working directory
is used. `requireRootMarker: true` adds a per-file Activation Gate: skip silently unless a marker
exists. An empty required marker list is invalid. Root-marker changes apply on the next mutation.

Global and project scalar settings override by scope. A project definition replaces the complete
global definition with the same ID; `null` disables it. Invalid definitions and fields are
quarantined individually and reported at session startup. An invalid project replacement still
shadows its global definition and same-ID built-in. Untrusted project settings are ignored.
Use Pi's `/reload` after settings edits.

## Acquisition, progress, and updates

Resolution order is **explicit settings → project-local tool/runtime → PATH → managed copy**.
Project executable discovery includes ancestor `node_modules`, `.bin`, Python `.venv`/`venv`,
`bin`, and `.cargo/bin` directories, bounded by the nearest Git/worktree root. Outside Git, the
boundary is Pi's working directory (or the changed file's directory for files outside it). A selected
Formatter Marker above that boundary extends discovery only when its directory also contains
`package.json`, `pyproject.toml`, or a Deno project config; a parent formatter-only configuration remains a preference, not
ownership of its executables. Other ancestor bins, including system/user bins, are considered only
through PATH. Node runtime selection is independent of tool selection:
a project/PATH Node can run managed Prettier/Biome. Standalone native Biome needs no Node; its npm
scripts and executable shims retain the Node prerequisite. Black's managed private Python environment
remains separate from the project's Python environment. External failures warn; they do not
silently substitute managed executables.

A qualifying mutation waits for first-use acquisition and then formatting. Pi's status area shows
progress; Escape cancels the active turn. Acquisition, cancellation, timeout, spawn, and formatter
failures append warnings **without changing a successful mutation into a failure**. Formatting is
never deferred to a background job. Reload/shutdown cancels and waits for active assistance.
Startup, project discovery, and unrelated mutations do not download anything.

The private per-user store is `<Pi agent directory>/managed-tools`, shared with Pi LSP and Pi DAP
across projects, worktrees, sessions, and processes. Managed IDs are `formatter-<preset ID>`; compatible framework plugins have separate `formatter-plugin-<framework>-<compatibility identity>` selections so incompatible projects do not overwrite one another. Privately acquired inspection runtimes use `formatter-prettier-helper-<compatibility identity>` selections.
The shared installer acquires Node for npm formatters, Python/uv for Black, Ruff's native binary,
Go/Rust toolchains for gofmt/rustfmt, native shfmt/Terraform/Deno, and Node-backed curated plugins. It resolves latest upstream (latest-compatible for plugins) on first acquisition, records
concrete versions, and reuses them until an explicit update. The store holds binaries, installation
metadata, and process coordination; Pi settings remain the configuration authority.

```text
/formatter update
/formatter update prettier
/formatter update cancel
```

Updates cover only **already installed, formatter-owned** managed presets (or the selected ID),
including any privately acquired supporting runtime. `/formatter update prettier` also advances existing curated-plugin and inspection-helper selections within their original compatibility constraints. They never install unused presets, update
project dependencies, or modify PATH-owned tools. Each tool reports old/new versions, no change,
or its failure; failed/cancelled updates retain the previous selection for subsequent mutations.
In the terminal, the native loader supports Escape and remains open through cleanup. RPC clients
can send `/formatter update cancel` as a second prompt during an idle update. RPC/headless execution
does not require terminal components or leave a dangling dialog. Headless hosts can cancel through
the command or session shutdown. Progress statuses are cleared when operations end.

## Supported mutations and coexistence

Formatting runs after successful native `edit` and `write`, Codex-style `apply_patch` results,
and applied Pi LSP Workspace Edit Previews. Changed/created files and rename destinations are
formatted; deleted or vanished files are skipped. Explicit formatters run sequentially, and all
formatting completes before later tool-result middleware. File Formatter processes hold Pi's native
per-file mutation queue through process exit, so concurrent native edits/writes cannot be overwritten
by an earlier formatter's stale snapshot. Workspace Formatters do not declare exact destination paths;
their commands remain responsible for coordinating broader mutations. Successful output is silent.

The Git collection loads Pi Formatter before Pi LSP so Post-edit Diagnostics observe formatted
content. Separately installed extensions depend on Pi's configured extension order. Formatter
installation state does not change tool definitions, system prompts, or earlier message history.

## Platforms and security

The shared installer supports native x64 and ARM64 Linux, macOS, and Windows; each preset may have a verified subset. The initial
[six-platform acquisition/launch evidence and verified OS baselines](https://github.com/ian-pascoe/pi-extensions/tree/main/packages/pi-tool-installer#initial-verified-baselines)
are separate from extension regression coverage. Host tests use Pi 0.85.1 and Node 22.19.0 or newer.
Older OS releases, musl Linux, and emulation are not covered by that evidence.

The expansion has native Linux x64 acquisition/use evidence for shfmt 3.14.1, Terraform 1.16.2, Deno 2.9.6, Prettier 3.9.6, Biome 2.5.13, and compatible Svelte/Astro plugins. Run `PI_FORMATTER_NATIVE=1` with `test/formatter-presets.native.test.ts` for real acquisition, exact formatting, ignored-file and no-project-setup checks; `PI_FORMATTER_NATIVE_DIR` optionally retains an isolated tool store. Published artifact availability is not evidence for additional platform cells.

Trusted settings and project-local executables/configurations run with Pi's permissions. Review
projects and binaries before trusting them. Managed acquisition uses package-owned selectors and a
private mise helper, with no user mise configuration/hooks or system/project installation changes.
Child-only environment changes leave the user's PATH and shell startup files untouched. The helper
binary is verified against its published SHA-256 digest; component acquisition/extraction is owned
by mise's backends, not an independent checksum/provenance guarantee for every transitive component.
