# Pi Formatter context

## Glossary

- **Formatter Definition** — a configured command, file matching policy, environment, and stable formatter ID. A project Formatter Definition completely replaces a global definition with the same ID; `null` or an invalid project replacement shadows the global definition.
- **File Formatter** — a Formatter Definition whose arguments contain `$FILE`. It runs once for each matching changed file.
- **Workspace Formatter** — a Formatter Definition whose arguments omit `$FILE`. It runs once when a mutation reports at least one matching changed file.
- **Supported Mutation Tool** — a file-modifying Pi tool whose destination paths can be identified exactly: native `edit`, native `write`, Codex-style `apply_patch`, or Pi LSP preview application.
- **Quarantined Setting** — an invalid configuration entry or field that is warned about and excluded without disabling unrelated valid configuration.

## Behavior boundary

Pi Formatter runs matching Formatter Definitions sequentially after a Supported Mutation Tool
reports changed destination files. Formatting completes before later tool-result middleware runs.
A successful mutation remains successful when formatting fails. Deleted and vanished files are
not formatter targets.

Formatter Definitions come only from the `formatter` key in Pi's global and trusted project
settings. Pi's standard reload lifecycle reloads configuration. The extension owns no formatter
catalog, executable installation, shell interpretation, or repository change discovery.
