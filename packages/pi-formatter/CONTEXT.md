# Pi Formatter context

Pi Formatter owns post-edit formatting selection and execution. Shared installation vocabulary
is defined by [Language Tools](../../docs/contexts/language-tools/CONTEXT.md); acquisition belongs
to the shared installer, while Formatter Definitions and Formatter Markers belong here.

## Glossary

- **Activation Gate** — an optional requirement that at least one configured root marker be present for a Formatter Definition to apply to a candidate file.
- **Formatter Definition** — a command, file matching policy, workspace-root policy, Activation Gate, environment, and stable formatter ID. An Explicit Definition replaces a same-ID Language Tool Preset; a project definition completely replaces a same-ID global definition.
- **File Formatter** — a Formatter Definition whose arguments contain `$FILE`, applied to each matching changed file.
- **Workspace Formatter** — a Formatter Definition whose arguments omit `$FILE`, applied once per matching workspace root reported by a mutation.
- **Formatter Marker** — a formatter-specific configuration file or parsed manifest declaration indicating a project's formatter preference. The nearest applicable directory owns the preference; a generic manifest alone is not a marker.
- **Explicit Definition** — a user-configured Formatter Definition, taking precedence over matching Language Tool Presets even when IDs differ or execution fails.
- **Language Tool Preset** — a package-owned fallback Formatter Definition and its acquisition requirements, distinct from an Explicit Definition.
- **Managed Installation** — a privately acquired formatter and supporting runtimes/toolchain components, distinct from a project-local or PATH-owned External Installation.
- **Installed-only Mode** — a policy permitting existing External and Managed Installations without automatic downloads; explicit Tool Updates remain deliberate network actions.
- **Tool Update** — an explicit advance of an installed, formatter-owned Managed Installation to latest upstream for subsequent formatting, retaining the working selection on failure or cancellation.
- **Supported Mutation Tool** — a file-modifying Pi tool whose destination paths can be identified exactly: native `edit`, native `write`, Codex-style `apply_patch`, or Pi LSP preview application.
- **Quarantined Setting** — an invalid configuration entry or field that is warned about and excluded without disabling unrelated valid configuration. A quarantined same-ID definition still shadows inherited and built-in definitions.
