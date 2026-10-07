# Pi Extensions

Source-TypeScript Pi extensions maintained by Ian Pascoe. Packages install
independently or together from this Git repository.

> **Security:** Pi packages run with full system access. Extensions execute
> arbitrary code and can run executables. Review source code and install only
> packages you trust.

## Packages

| Package                                                               | Purpose                                                      | Install                                            |
| --------------------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------- |
| [`@ian-pascoe/pi-minimal-subagents`](packages/pi-minimal-subagents)   | Persistent nested-agent coordination.                        | `pi install npm:@ian-pascoe/pi-minimal-subagents`  |
| [`@ian-pascoe/pi-bible-verses`](packages/pi-bible-verses)             | Offline rotating verse working messages.                     | `pi install npm:@ian-pascoe/pi-bible-verses`       |
| [`@ian-pascoe/pi-tps-tracker`](packages/pi-tps-tracker)               | Assistant output-token throughput.                           | `pi install npm:@ian-pascoe/pi-tps-tracker`        |
| [`@ian-pascoe/pi-command-deck`](packages/pi-command-deck)             | Vim prompt editor with session and Git status borders.       | `pi install npm:@ian-pascoe/pi-command-deck`       |
| [`@ian-pascoe/pi-git-checkpoints`](packages/pi-git-checkpoints)       | Git-backed worktree checkpoints for tree navigation.         | `pi install npm:@ian-pascoe/pi-git-checkpoints`    |
| [`@ian-pascoe/pi-formatter`](packages/pi-formatter)                   | Configured automatic post-edit formatting.                   | `pi install npm:@ian-pascoe/pi-formatter`          |
| [`@ian-pascoe/pi-lsp`](packages/pi-lsp)                               | Configured language-server tools and post-edit diagnostics.  | `pi install npm:@ian-pascoe/pi-lsp`                |
| [`@ian-pascoe/pi-dap`](packages/pi-dap)                               | Configured Debug Adapter Protocol sessions.                  | `pi install npm:@ian-pascoe/pi-dap`                |
| [`@ian-pascoe/pi-web-tools`](packages/pi-web-tools)                   | Public web search and textual URL retrieval.                 | `pi install npm:@ian-pascoe/pi-web-tools`          |
| [`@ian-pascoe/pi-todo`](packages/pi-todo)                             | Minimal session-native Todo List for agents.                 | `pi install npm:@ian-pascoe/pi-todo`               |
| [`@ian-pascoe/pi-context-management`](packages/pi-context-management) | Session Notes, History retrieval, and native Rollover.       | `pi install npm:@ian-pascoe/pi-context-management` |
| [`@ian-pascoe/pi-skills-selector`](packages/pi-skills-selector)       | Native `$skill-name` completion and instruction links.       | `pi install npm:@ian-pascoe/pi-skills-selector`    |
| [`@ian-pascoe/pi-advisor`](packages/pi-advisor)                       | Optional background review and attributed corrective advice. | `pi install npm:@ian-pascoe/pi-advisor`            |
| [`@ian-pascoe/pi-termctrl`](packages/pi-termctrl)                     | Interactive Terminals, Background jobs, and a `/ps` panel.   | `pi install npm:@ian-pascoe/pi-termctrl`           |
| [`@ian-pascoe/pi-guardian`](packages/pi-guardian)                     | Model-reviewed gating of risky tool calls before they run.   | `pi install npm:@ian-pascoe/pi-guardian`           |

`@ian-pascoe/pi-codemode` and `@ian-pascoe/pi-mcp` are retired in favor of Pi's
built-in `codemode` (`defaultTools: ["+codemode"]`) and MCP support (`mcp.json`).
`@ian-pascoe/pi-git-status-widget` is retired; Command Deck shows Git worktree status.

The extensions share terminal capability and native session discovery utilities through the conventional
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
        "packages/pi-minimal-subagents/src/index.ts",
        "packages/pi-bible-verses/src/index.ts"
      ],
      "skills": [
        "packages/pi-minimal-subagents/skills/pi-minimal-subagents/SKILL.md",
        "packages/pi-bible-verses/skills/pi-bible-verses/SKILL.md"
      ]
    }
  ]
}
```

Every selectable extension path is:

```text
packages/pi-command-deck/src/index.ts
packages/pi-minimal-subagents/src/index.ts
packages/pi-bible-verses/src/index.ts
packages/pi-tps-tracker/src/index.ts
packages/pi-git-checkpoints/src/index.ts
packages/pi-formatter/src/index.ts
packages/pi-lsp/src/index.ts
packages/pi-dap/src/index.ts
packages/pi-web-tools/src/index.ts
packages/pi-todo/src/index.ts
packages/pi-context-management/src/index.ts
packages/pi-skills-selector/src/index.ts
packages/pi-advisor/src/index.ts
packages/pi-termctrl/src/index.ts
packages/pi-guardian/src/index.ts
```

Every selectable configuration skill path is:

```text
packages/pi-command-deck/skills/pi-command-deck/SKILL.md
packages/pi-minimal-subagents/skills/pi-minimal-subagents/SKILL.md
packages/pi-bible-verses/skills/pi-bible-verses/SKILL.md
packages/pi-tps-tracker/skills/pi-tps-tracker/SKILL.md
packages/pi-git-checkpoints/skills/pi-git-checkpoints/SKILL.md
packages/pi-formatter/skills/pi-formatter/SKILL.md
packages/pi-lsp/skills/pi-lsp/SKILL.md
packages/pi-dap/skills/pi-dap/SKILL.md
packages/pi-web-tools/skills/pi-web-tools/SKILL.md
packages/pi-todo/skills/pi-todo/SKILL.md
packages/pi-context-management/skills/pi-context-management/SKILL.md
packages/pi-skills-selector/skills/pi-skills-selector/SKILL.md
packages/pi-advisor/skills/pi-advisor/SKILL.md
packages/pi-termctrl/skills/pi-termctrl/SKILL.md
packages/pi-guardian/skills/pi-guardian/SKILL.md
```

Pin a tag or commit for reproducible Git installs:

```bash
pi install git:github.com/ian-pascoe/pi-extensions@<tag-or-commit>
```

## Prerequisites

- Command Deck replaces the prompt editor; list it before extensions that wrap the editor, such as Minimal Subagents.
- Command Deck needs `git` on `PATH` to show Git status; without it the Deck Header omits Git status.
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
- Pi Web Tools needs outbound network access. `EXA_API_KEY` and
  `PARALLEL_API_KEY` are optional provider credentials.
- Pi Context Management's native-checkpoint adapter checks the private runtime members it needs and fails closed when they are missing.
- Pi Termctrl Terminals need the `termctrl` binary that `@kitlangton/terminal-control`
  installs for macOS and GNU/Linux on arm64 or x64. Elsewhere only the `bash`
  replacement and Background jobs work.
- Pi Guardian is enabled by default and reviews risky tool calls with the session's model unless configured; load it last so no later extension rewrites reviewed arguments.
- Pi Advisor is disabled by default. Loaded Context Management requires all three private context-tool grants; incompatible tool exposure pauses review rather than expanding permissions.

See package READMEs for configuration. The repository MIT license covers
package code; Bible Verses documents separate embedded-text rights and
provenance.

## Contributing

`mise.toml` pins the required Node and pnpm versions; run `mise install` to get them.

Published packages support Node `>=22.19.0` and Pi `>=0.99.0`, the first release with the tool exposure, output schema, and built-in extension APIs they use. The repository develops and tests against Pi `1.0.0`. Pi Command Deck reaches private editor fields and falls back to Pi's plain editor where they differ.

```bash
pnpm install
pnpm verify
```

`pnpm verify` runs through Turborepo, which caches each check by its inputs. A rerun on unchanged files, including the pre-push hook after a commit, replays from `.turbo/cache`.
A package task's inputs cover only its own files and its declared workspace dependencies. When a test imports another package by relative path or reads a repository file, add that path to the task's `inputs` in `turbo.json`; otherwise a change there replays a stale pass.

Focused package checks:

```bash
pnpm --filter @ian-pascoe/pi-minimal-subagents test
pnpm --filter @ian-pascoe/pi-bible-verses test
pnpm --filter @ian-pascoe/pi-tps-tracker test
pnpm --filter @ian-pascoe/pi-command-deck test
pnpm --filter @ian-pascoe/pi-git-checkpoints test
pnpm --filter @ian-pascoe/pi-formatter test
pnpm --filter @ian-pascoe/pi-lsp test
pnpm --filter @ian-pascoe/pi-dap test
pnpm --filter @ian-pascoe/pi-web-tools typecheck
pnpm --filter @ian-pascoe/pi-web-tools test
pnpm --filter @ian-pascoe/pi-todo typecheck
pnpm --filter @ian-pascoe/pi-todo test
pnpm --filter @ian-pascoe/pi-context-management typecheck
pnpm --filter @ian-pascoe/pi-context-management test
pnpm --filter @ian-pascoe/pi-skills-selector typecheck
pnpm --filter @ian-pascoe/pi-skills-selector test
pnpm --filter @ian-pascoe/pi-utils test
pnpm --filter @ian-pascoe/pi-advisor typecheck
pnpm --filter @ian-pascoe/pi-advisor test
pnpm --filter @ian-pascoe/pi-termctrl typecheck
pnpm --filter @ian-pascoe/pi-termctrl test
pnpm --filter @ian-pascoe/pi-guardian typecheck
pnpm --filter @ian-pascoe/pi-guardian test
pnpm test:root
```

`pnpm test:root` runs the repository-level tests in `test/`, which exercise several packages together (for example Pi Formatter before Pi LSP, in the collection's extension order). `pnpm verify` runs it.

Read [`CONTEXT-MAP.md`](CONTEXT-MAP.md), ADRs, and
[`docs/releases.md`](docs/releases.md) before changing behavior or releasing.
