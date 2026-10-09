# Pi Extensions glossary map

Read the repository ADRs before a package glossary, then read only the package
glossary relevant to the work:

| Package                             | Glossary                                                                                   | Domain focus                            |
| ----------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------- |
| `@ian-pascoe/pi-advisor`            | [`packages/pi-advisor/GLOSSARY.md`](packages/pi-advisor/GLOSSARY.md)                       | Session review and tool grants          |
| `@ian-pascoe/pi-minimal-subagents`  | [`packages/pi-minimal-subagents/GLOSSARY.md`](packages/pi-minimal-subagents/GLOSSARY.md)   | Persistent nested agents                |
| `@ian-pascoe/pi-bible-verses`       | [`packages/pi-bible-verses/GLOSSARY.md`](packages/pi-bible-verses/GLOSSARY.md)             | Offline verse rotation and provenance   |
| `@ian-pascoe/pi-tps-tracker`        | [`packages/pi-tps-tracker/GLOSSARY.md`](packages/pi-tps-tracker/GLOSSARY.md)               | Output-token throughput measurement     |
| `@ian-pascoe/pi-command-deck`       | [`packages/pi-command-deck/GLOSSARY.md`](packages/pi-command-deck/GLOSSARY.md)             | Vim prompt editor and session chrome    |
| `@ian-pascoe/pi-git-checkpoints`    | [`packages/pi-git-checkpoints/GLOSSARY.md`](packages/pi-git-checkpoints/GLOSSARY.md)       | Session-linked worktree restoration     |
| `@ian-pascoe/pi-formatter`          | [`packages/pi-formatter/GLOSSARY.md`](packages/pi-formatter/GLOSSARY.md)                   | Automatic post-edit formatting          |
| `@ian-pascoe/pi-lsp`                | [`packages/pi-lsp/GLOSSARY.md`](packages/pi-lsp/GLOSSARY.md)                               | Language-server tools and edit feedback |
| `@ian-pascoe/pi-dap`                | [`packages/pi-dap/GLOSSARY.md`](packages/pi-dap/GLOSSARY.md)                               | Interactive debug sessions              |
| `@ian-pascoe/pi-termctrl`           | [`packages/pi-termctrl/GLOSSARY.md`](packages/pi-termctrl/GLOSSARY.md)                     | Terminals and Background jobs           |
| `@ian-pascoe/pi-web-tools`          | [`packages/pi-web-tools/GLOSSARY.md`](packages/pi-web-tools/GLOSSARY.md)                   | Public web search and retrieval         |
| `@ian-pascoe/pi-todo`               | [`packages/pi-todo/GLOSSARY.md`](packages/pi-todo/GLOSSARY.md)                             | Minimal session work tracking           |
| `@ian-pascoe/pi-context-management` | [`packages/pi-context-management/GLOSSARY.md`](packages/pi-context-management/GLOSSARY.md) | Session Notes, History, and Rollover    |
| `@ian-pascoe/pi-skills-selector`    | [`packages/pi-skills-selector/GLOSSARY.md`](packages/pi-skills-selector/GLOSSARY.md)       | Explicit Skill References in user input |
| `@ian-pascoe/pi-guardian`           | [`packages/pi-guardian/GLOSSARY.md`](packages/pi-guardian/GLOSSARY.md)                     | Model-reviewed tool-call gating         |
| `@ian-pascoe/pi-utils`              | [`packages/pi-utils/GLOSSARY.md`](packages/pi-utils/GLOSSARY.md)                           | Shared extension UI conventions         |

`pi-context-management` implements session-local Notes, selected-branch History retrieval,
and native Context Checkpoints for capability-compatible Pi runtimes.

`pi-advisor` reviews main Pi sessions and optionally their Minimal Subagents descendants.
It inherits the observed session's extensions and grants tools separately. When Context
Management is available and its tools are granted, they address the private Advisor
Session rather than the observed agent's Notes, History, or Context Checkpoints.

The package glossaries are package-local vocabulary authorities. Repository-wide decisions
live in [`docs/adr/`](docs/adr/).
