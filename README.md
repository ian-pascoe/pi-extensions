# Pi Extensions

Source-TypeScript Pi extensions maintained by Ian Pascoe. Packages install
independently or together from this Git repository.

> **Security:** Pi packages run with full system access. Extensions execute
> arbitrary code and can run executables. Review source code and install only
> packages you trust.

## Packages

| Package                                                               | Purpose                                                     | Install                                            |
| --------------------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------- |
| [`@ian-pascoe/pi-minimal-subagents`](packages/pi-minimal-subagents)   | Persistent nested-agent coordination.                       | `pi install npm:@ian-pascoe/pi-minimal-subagents`  |
| [`@ian-pascoe/pi-bible-verses`](packages/pi-bible-verses)             | Offline rotating verse working messages.                    | `pi install npm:@ian-pascoe/pi-bible-verses`       |
| [`@ian-pascoe/pi-tps-tracker`](packages/pi-tps-tracker)               | Assistant output-token throughput.                          | `pi install npm:@ian-pascoe/pi-tps-tracker`        |
| [`@ian-pascoe/pi-git-status-widget`](packages/pi-git-status-widget)   | Refreshing Git worktree status.                             | `pi install npm:@ian-pascoe/pi-git-status-widget`  |
| [`@ian-pascoe/pi-git-checkpoints`](packages/pi-git-checkpoints)       | Git-backed worktree checkpoints for tree navigation.        | `pi install npm:@ian-pascoe/pi-git-checkpoints`    |
| [`@ian-pascoe/pi-formatter`](packages/pi-formatter)                   | Marker-aware post-edit formatting with managed tools.       | `pi install npm:@ian-pascoe/pi-formatter`          |
| [`@ian-pascoe/pi-lsp`](packages/pi-lsp)                               | Language-server defaults, tools, and post-edit diagnostics. | `pi install npm:@ian-pascoe/pi-lsp`                |
| [`@ian-pascoe/pi-dap`](packages/pi-dap)                               | Direct JavaScript/Python debugging and configured sessions. | `pi install npm:@ian-pascoe/pi-dap`                |
| [`@ian-pascoe/pi-codemode`](packages/pi-codemode)                     | Persistent TypeScript composition of registered Pi tools.   | `pi install npm:@ian-pascoe/pi-codemode`           |
| [`@ian-pascoe/pi-mcp`](packages/pi-mcp)                               | Model Context Protocol hosting for configured MCP servers.  | `pi install npm:@ian-pascoe/pi-mcp`                |
| [`@ian-pascoe/pi-web-tools`](packages/pi-web-tools)                   | Public web search and textual URL retrieval.                | `pi install npm:@ian-pascoe/pi-web-tools`          |
| [`@ian-pascoe/pi-todo`](packages/pi-todo)                             | Minimal session-native Todo List for agents.                | `pi install npm:@ian-pascoe/pi-todo`               |
| [`@ian-pascoe/pi-context-management`](packages/pi-context-management) | Session Notes, History retrieval, and native Rollover.      | `pi install npm:@ian-pascoe/pi-context-management` |
| [`@ian-pascoe/pi-skills-selector`](packages/pi-skills-selector)       | Native `$skill-name` completion and instruction links.      | `pi install npm:@ian-pascoe/pi-skills-selector`    |

The extensions share terminal capability decisions through the conventional
compiled library [`@ian-pascoe/pi-utils`](packages/pi-utils). It is an npm
dependency, not a Pi extension or configuration skill. LSP, DAP, and Formatter also
share [`@ian-pascoe/pi-tool-installer`](packages/pi-tool-installer), which privately
acquires missing language tools and runtimes without a separate Pi installation.

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
packages/pi-web-tools/src/index.ts
packages/pi-todo/src/index.ts
packages/pi-context-management/src/index.ts
packages/pi-skills-selector/src/index.ts
```

Every selectable configuration skill path is:

```text
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
packages/pi-web-tools/skills/pi-web-tools/SKILL.md
packages/pi-todo/skills/pi-todo/SKILL.md
packages/pi-context-management/skills/pi-context-management/SKILL.md
packages/pi-skills-selector/skills/pi-skills-selector/SKILL.md
```

Pin a tag or commit for reproducible Git installs:

```bash
pi install git:github.com/ian-pascoe/pi-extensions@<tag-or-commit>
```

## Prerequisites

- Git Status Widget needs `git` on `PATH`.
- Git Checkpoints needs `git` on `PATH`; the starting directory need not be a repository.
- Minimal Subagents can use optional `trash`; deletion otherwise unlinks.
- TPS Tracker can use optional `tiktoken`; absent official usage and tokenizer,
  it estimates four characters per token.
- Pi LSP and Formatter provide TypeScript/JavaScript, Python, Go, and Rust defaults;
  Pi DAP provides direct Node JavaScript and Python script launches. Missing tools
  and runtimes are acquired privately on first use, requiring outbound network
  access. Explicit configuration and project/PATH tools take precedence. Set the
  package's `autoInstall` setting to `false` for Installed-only Mode; explicit
  update commands remain network actions. See package READMEs for formatter
  selection, additional debug profiles, and the [verified native platform
  baselines](packages/pi-tool-installer/README.md#initial-verified-baselines).
- Pi CodeMode installs Deno 2.9.5 and runs TypeScript Cells directly in a
  permission-denied Deno subprocess; registered Pi tools still execute with
  their normal host permissions.
- Pi Web Tools needs outbound network access. `EXA_API_KEY` and
  `PARALLEL_API_KEY` are optional provider credentials.
- Pi Context Management requires exactly Pi `0.85.1` because its native-checkpoint adapter is version-guarded.

See package READMEs for configuration. The repository MIT license covers
package code; Bible Verses documents separate embedded-text rights and
provenance.

## Contributing

Node `22.19.0` and pnpm `11.21.0` are required.

Published packages support Node `>=22.19.0` and Pi `>=0.84.1`, except Pi Context Management, which requires exactly Pi `0.85.1`, and Pi Skills Selector, which requires Pi `>=0.85.1` for stacked autocomplete.

```bash
pnpm install
pnpm verify
```

Focused package checks:

```bash
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
pnpm --filter @ian-pascoe/pi-web-tools typecheck
pnpm --filter @ian-pascoe/pi-web-tools test
pnpm --filter @ian-pascoe/pi-todo typecheck
pnpm --filter @ian-pascoe/pi-todo test
pnpm --filter @ian-pascoe/pi-context-management typecheck
pnpm --filter @ian-pascoe/pi-context-management test
pnpm --filter @ian-pascoe/pi-skills-selector typecheck
pnpm --filter @ian-pascoe/pi-skills-selector test
pnpm --filter @ian-pascoe/pi-utils test
pnpm --filter @ian-pascoe/pi-tool-installer test
```

Read [`CONTEXT-MAP.md`](CONTEXT-MAP.md), ADRs, and
[`docs/releases.md`](docs/releases.md) before changing behavior or releasing.
