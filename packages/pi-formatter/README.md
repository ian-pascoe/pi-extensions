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

| Preset ID  | Files                            | Selection               | Invocation                                                     |
| ---------- | -------------------------------- | ----------------------- | -------------------------------------------------------------- |
| `prettier` | JS/JSX, TS/TSX, MJS/CJS, MTS/CTS | Nearest Prettier Marker | `prettier --write FILE`                                        |
| `biome`    | Same JavaScript/TypeScript files | Nearest Biome Marker    | `biome format --write FILE`                                    |
| `black`    | `.py`, `.pyi`                    | Nearest Black Marker    | `black FILE`                                                   |
| `ruff`     | `.py`, `.pyi`                    | Nearest Ruff Marker     | `ruff format FILE`                                             |
| `gofmt`    | `.go`                            | Conventional default    | `gofmt -w FILE`                                                |
| `rustfmt`  | `.rs`                            | Conventional default    | `rustfmt [--edition EDITION] --config skip_children=true FILE` |

JS/TS and Python files with **no declared formatter preference are left alone**. A generic
`package.json` or `pyproject.toml` is not a Formatter Marker. Discovery walks from the changed
file toward the filesystem root, selecting the nearest directory with a preference, including
nested monorepo packages. Marker files and manifest declarations are reread on each mutation.

Recognized Formatter Markers:

- **Prettier:** `.prettierrc`; `.prettierrc.{json,json5,yml,yaml,toml,js,cjs,mjs,ts,cts,mts}`;
  `prettier.config.{js,cjs,mjs,ts,cts,mts}`; a `package.json` `prettier` configuration object/string;
  or a `prettier` entry in `dependencies` or `devDependencies`.
- **Biome:** `biome.json`, `biome.jsonc`, or `@biomejs/biome` in `package.json` `dependencies` or
  `devDependencies`.
- **Black:** a parsed `pyproject.toml` `[tool.black]` table or a Black dependency declaration.
- **Ruff:** `ruff.toml`, `.ruff.toml`, a parsed `[tool.ruff]` table, or a Ruff dependency declaration.
- Python dependency declarations include PEP 621 `project.dependencies` and
  `project.optional-dependencies`, PEP 735 `dependency-groups`, `tool.uv.dev-dependencies`, and
  Poetry `dependencies`, `dev-dependencies`, and group dependencies. Distribution names are
  parsed; mentions in descriptions, comments, URLs, or unrelated settings do not select a tool.

Conflicting alternatives at the same directory warn and leave the file unchanged. For example,
using Ruff for linting and Black for formatting requires an explicit Black Formatter Definition.
Malformed relevant manifests produce a warning instead of a guessed selection. Formatter configs
remain owned by the formatter itself; discovery does not execute JS/TS configuration files.

Rust uses the nearest `Cargo.toml` package edition, including `edition.workspace = true` and
`package.workspace` locations. A native `rustfmt.toml`/`.rustfmt.toml` edition takes precedence.
Without an edition declaration, rustfmt keeps its native default. Pi invokes rustfmt on the changed
file with `--config skip_children=true`, not `cargo fmt`, so out-of-line sibling modules
are not rewritten. Other native formatter configuration still applies.

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
`package.json` or `pyproject.toml`; a parent configuration file alone remains a preference, not
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
across projects, worktrees, sessions, and processes. Managed IDs are `formatter-<preset ID>`.
The shared installer acquires Node for npm formatters, Python/uv for Black, Ruff's native binary,
and Go/Rust toolchains for gofmt/rustfmt. It resolves latest upstream on first acquisition, records
concrete versions, and reuses them until an explicit update. The store holds binaries, installation
metadata, and process coordination; Pi settings remain the configuration authority.

```text
/formatter update
/formatter update prettier
/formatter update cancel
```

Updates cover only **already installed, formatter-owned** managed presets (or the selected ID),
including any privately acquired supporting runtime. They never install unused presets, update
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

Managed tools target native x64 and ARM64 Linux, macOS, and Windows equally. The initial
[six-platform acquisition/launch evidence and verified OS baselines](https://github.com/ian-pascoe/pi-extensions/tree/main/packages/pi-tool-installer#initial-verified-baselines)
are separate from extension regression coverage. Host tests use Pi 0.85.1 and Node 22.19.0 or newer.
Older OS releases, musl Linux, and emulation are not covered by that evidence.

Trusted settings and project-local executables/configurations run with Pi's permissions. Review
projects and binaries before trusting them. Managed acquisition uses package-owned selectors and a
private mise helper, with no user mise configuration/hooks or system/project installation changes.
Child-only environment changes leave the user's PATH and shell startup files untouched. The helper
binary is verified against its published SHA-256 digest; component acquisition/extraction is owned
by mise's backends, not an independent checksum/provenance guarantee for every transitive component.
