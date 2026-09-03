# Pi Extensions

Source-TypeScript Pi extensions maintained by Ian Pascoe. Packages install
independently or together from this Git repository.

> **Security:** Pi packages run with full system access. Extensions execute
> arbitrary code and can run executables. Review source code and install only
> packages you trust.

## Packages

| Package                                                             | Purpose                                                       | Install                                           |
| ------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------- |
| [`pi-adaptive-thinking`](packages/pi-adaptive-thinking)             | Session-safe temporary and persistent thinking-level changes. | `pi install npm:pi-adaptive-thinking`             |
| [`pi-byterover`](packages/pi-byterover)                             | ByteRover memory recall and curation.                         | `pi install npm:pi-byterover`                     |
| [`@ian-pascoe/pi-minimal-subagents`](packages/pi-minimal-subagents) | Persistent nested-agent coordination.                         | `pi install npm:@ian-pascoe/pi-minimal-subagents` |
| [`@ian-pascoe/pi-bible-verses`](packages/pi-bible-verses)           | Offline rotating verse working messages.                      | `pi install npm:@ian-pascoe/pi-bible-verses`      |
| [`@ian-pascoe/pi-tps-tracker`](packages/pi-tps-tracker)             | Assistant output-token throughput.                            | `pi install npm:@ian-pascoe/pi-tps-tracker`       |
| [`@ian-pascoe/pi-git-status-widget`](packages/pi-git-status-widget) | Refreshing Git worktree status.                               | `pi install npm:@ian-pascoe/pi-git-status-widget` |
| [`@ian-pascoe/pi-git-checkpoints`](packages/pi-git-checkpoints)     | Git-backed worktree checkpoints for tree navigation.          | `pi install npm:@ian-pascoe/pi-git-checkpoints`   |
| [`@ian-pascoe/pi-formatter`](packages/pi-formatter)                 | Configured automatic post-edit formatting.                    | `pi install npm:@ian-pascoe/pi-formatter`         |
| [`@ian-pascoe/pi-lsp`](packages/pi-lsp)                             | Configured language-server tools and post-edit diagnostics.   | `pi install npm:@ian-pascoe/pi-lsp`               |
| [`@ian-pascoe/pi-dap`](packages/pi-dap)                             | Configured Debug Adapter Protocol sessions.                   | `pi install npm:@ian-pascoe/pi-dap`               |
| [`@ian-pascoe/pi-codemode`](packages/pi-codemode)                   | Persistent TypeScript composition of registered Pi tools.     | `pi install npm:@ian-pascoe/pi-codemode`          |
| [`@ian-pascoe/pi-mcp`](packages/pi-mcp)                             | Model Context Protocol hosting for configured MCP servers.    | `pi install npm:@ian-pascoe/pi-mcp`               |

The extensions share terminal capability decisions through the conventional
compiled library [`@ian-pascoe/pi-utils`](packages/pi-utils). It is an npm
dependency, not a Pi extension or configuration skill.

## Install the collection from Git

```bash
pi install git:github.com/ian-pascoe/pi-extensions
```

Use `-l` for a project-local installation. To filter the collection, use a Pi
package entry with resource paths relative to the repository root:

```json
{
  "packages": [
    {
      "source": "git:github.com/ian-pascoe/pi-extensions",
      "extensions": [
        "packages/pi-adaptive-thinking/src/index.ts",
        "packages/pi-byterover/src/index.ts"
      ],
      "skills": [
        "packages/pi-adaptive-thinking/skills/pi-adaptive-thinking/SKILL.md",
        "packages/pi-byterover/skills/pi-byterover/SKILL.md"
      ]
    }
  ]
}
```

Every selectable extension path is:

```text
packages/pi-adaptive-thinking/src/index.ts
packages/pi-byterover/src/index.ts
packages/pi-minimal-subagents/src/index.ts
packages/pi-bible-verses/src/index.ts
packages/pi-tps-tracker/src/index.ts
packages/pi-git-status-widget/src/index.ts
packages/pi-git-checkpoints/src/index.ts
packages/pi-formatter/src/index.ts
packages/pi-lsp/src/index.ts
packages/pi-dap/src/index.ts
packages/pi-codemode/src/index.ts
packages/pi-mcp/src/index.ts
```

Every selectable configuration skill path is:

```text
packages/pi-adaptive-thinking/skills/pi-adaptive-thinking/SKILL.md
packages/pi-byterover/skills/pi-byterover/SKILL.md
packages/pi-minimal-subagents/skills/pi-minimal-subagents/SKILL.md
packages/pi-bible-verses/skills/pi-bible-verses/SKILL.md
packages/pi-tps-tracker/skills/pi-tps-tracker/SKILL.md
packages/pi-git-status-widget/skills/pi-git-status-widget/SKILL.md
packages/pi-git-checkpoints/skills/pi-git-checkpoints/SKILL.md
packages/pi-formatter/skills/pi-formatter/SKILL.md
packages/pi-lsp/skills/pi-lsp/SKILL.md
packages/pi-dap/skills/pi-dap/SKILL.md
packages/pi-codemode/skills/pi-codemode/SKILL.md
packages/pi-mcp/skills/pi-mcp/SKILL.md
```

Pin a tag or commit for reproducible Git installs:

```bash
pi install git:github.com/ian-pascoe/pi-extensions@<tag-or-commit>
```

## Prerequisites

- ByteRover needs the `brv` CLI (or a configured custom `brvPath`).
- Git Status Widget needs `git` on `PATH`.
- Git Checkpoints needs `git` on `PATH`; the starting directory need not be a repository.
- Minimal Subagents can use optional `trash`; deletion otherwise unlinks.
- TPS Tracker can use optional `tiktoken`; absent official usage and tokenizer,
  it estimates four characters per token.
- Pi Formatter requires separately installed formatter binaries.
- Pi LSP requires separately installed language-server binaries. This repository
  uses the installed TypeScript 7 `tsc --lsp --stdio` server.
- Pi DAP requires a separately managed Debug Adapter executable. The repository's
  `vscode-js-debug` development dependency supports its local Node smoke profile; its files are
  not packed or installed with `@ian-pascoe/pi-dap`.
- Pi CodeMode installs Deno 2.9.5 and runs TypeScript Cells directly in a
  permission-denied Deno subprocess; registered Pi tools still execute with
  their normal host permissions.

See package READMEs for configuration. The repository MIT license covers
package code; Bible Verses documents separate embedded-text rights and
provenance.

## Contributing

Node `22.19.0` and pnpm `11.21.0` are required.

Published packages support Node `>=22.19.0` and Pi `>=0.84.1`.

```bash
pnpm install
pnpm verify
```

Focused package checks:

```bash
pnpm --filter pi-adaptive-thinking typecheck
pnpm --filter pi-byterover test
pnpm --filter @ian-pascoe/pi-minimal-subagents test
pnpm --filter @ian-pascoe/pi-bible-verses test
pnpm --filter @ian-pascoe/pi-tps-tracker test
pnpm --filter @ian-pascoe/pi-git-status-widget test
pnpm --filter @ian-pascoe/pi-git-checkpoints test
pnpm --filter @ian-pascoe/pi-formatter test
pnpm --filter @ian-pascoe/pi-lsp test
pnpm --filter @ian-pascoe/pi-dap test
pnpm --filter @ian-pascoe/pi-codemode test
pnpm --filter @ian-pascoe/pi-mcp typecheck
pnpm --filter @ian-pascoe/pi-mcp test
pnpm --filter @ian-pascoe/pi-mcp build:cli
pnpm --filter @ian-pascoe/pi-utils test
```

Read [`CONTEXT-MAP.md`](CONTEXT-MAP.md), ADRs, and
[`docs/releases.md`](docs/releases.md) before changing behavior or releasing.
