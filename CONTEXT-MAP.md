# Pi Extensions context map

Read the repository ADRs before a package context, then read only the package
context relevant to the work:

| Package                            | Context                                                                                | Domain focus                            |
| ---------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------- |
| `pi-adaptive-thinking`             | [`packages/pi-adaptive-thinking/CONTEXT.md`](packages/pi-adaptive-thinking/CONTEXT.md) | Session thinking-level control          |
| `pi-byterover`                     | [`packages/pi-byterover/CONTEXT.md`](packages/pi-byterover/CONTEXT.md)                 | ByteRover recall and curation           |
| `@ian-pascoe/pi-minimal-subagents` | [`packages/pi-minimal-subagents/CONTEXT.md`](packages/pi-minimal-subagents/CONTEXT.md) | Persistent nested agents                |
| `@ian-pascoe/pi-bible-verses`      | [`packages/pi-bible-verses/CONTEXT.md`](packages/pi-bible-verses/CONTEXT.md)           | Offline verse rotation and provenance   |
| `@ian-pascoe/pi-tps-tracker`       | [`packages/pi-tps-tracker/CONTEXT.md`](packages/pi-tps-tracker/CONTEXT.md)             | Output-token throughput measurement     |
| `@ian-pascoe/pi-git-status-widget` | [`packages/pi-git-status-widget/CONTEXT.md`](packages/pi-git-status-widget/CONTEXT.md) | Worktree-status display refresh         |
| `@ian-pascoe/pi-git-checkpoints`   | [`packages/pi-git-checkpoints/CONTEXT.md`](packages/pi-git-checkpoints/CONTEXT.md)     | Session-linked worktree restoration     |
| `@ian-pascoe/pi-formatter`         | [`packages/pi-formatter/CONTEXT.md`](packages/pi-formatter/CONTEXT.md)                 | Automatic post-edit formatting          |
| `@ian-pascoe/pi-lsp`               | [`packages/pi-lsp/CONTEXT.md`](packages/pi-lsp/CONTEXT.md)                             | Language-server tools and edit feedback |

The contexts are package-local vocabulary authorities. Repository-wide decisions
live in [`docs/adr/`](docs/adr/).
