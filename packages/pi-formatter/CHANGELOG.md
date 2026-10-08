# @ian-pascoe/pi-formatter

## 0.6.0

### Minor Changes

- 4ef1998: The settings warning notification now reads `Formatter: settings: ...`. Requires Pi 1.1.0 or newer.

### Patch Changes

- Updated dependencies [4ef1998]
- Updated dependencies [4ef1998]
  - @ian-pascoe/pi-utils@0.5.0

## 0.5.1

### Patch Changes

- 7ef5ac5: Format inside Pi's file mutation queue. With parallel `edit`s to one file, the `Formatted by` diff now shows only the formatter's changes instead of another edit's, an edit that arrives while a formatter runs waits for it instead of being overwritten, and a file deleted or renamed by a mutation queued ahead of formatting is skipped. A formatter that times out or is aborted is now killed with `SIGKILL`, and formatting waits, for at most two seconds, until any process it started stops writing.

## 0.5.0

### Minor Changes

- 4e274cb: After a formatter changes a file, the mutation result now includes a compact unified diff of the changes (capped at 60 diff lines and 6,000 bytes per result, falling back to the `Formatted by` summary line alone), so the agent's next `edit` can match the formatted text without re-reading the file.

## 0.4.0

### Minor Changes

- 52d1411: Formatters that change a file now say so. After a successful `edit`, `write`, `apply_patch`, or applied Workspace Edit Preview (`lsp_apply`), the result gains one line per changed file naming every formatter that changed it, such as `Formatted by ruff-fix, ruff-format: lines 3–13 changed`, so the agent knows its copy of the file is stale; before, formatting was silent and the next `edit` reusing the just-written text failed with "Could not find the exact text". The line numbers describe the formatted file, as one span from the first to the last line that differs from the content before formatting, and nothing is added when the content is unchanged. Changes by a formatter that exits non-zero or times out are reported too, after the failure warnings. A formatter failure whose stderr reports a syntax error in the changed file, which Post-edit Diagnostics already reports, no longer ends with the troubleshooting Skill pointer; spawn errors, timeouts, configuration errors, and other failures keep it.
- bad2049: A File Formatter can now declare how it reports a syntax error with the optional `syntaxErrorPattern` setting, a regular expression tested against its stderr. When set, it replaces the built-in wording heuristic for that formatter: a non-zero exit whose stderr matches drops the troubleshooting Skill pointer, and any other non-zero exit keeps it, while timeouts and spawn errors always keep it. Without the setting, behavior is unchanged. An invalid regular expression, or a pattern on a Workspace Formatter (no `$FILE` in `args`), quarantines the definition with a startup warning. The README gives oxfmt and ruff examples.

## 0.3.0

### Minor Changes

- 1c6bc03: Requires Pi 0.99.0 or later. Format files changed by `lsp_apply`, the Pi LSP tool that replaces the single `lsp` tool's apply operation. Results of the `lsp` tool are still recognized. Formatter warnings appended to a tool result no longer drop that result's structured content, which `codemode` scripts receive.

### Patch Changes

- 0ea1e75: Declare Pi `>=0.99.0` as the peer range for `@earendil-works/pi-coding-agent`, `pi-ai`, `pi-agent-core`, and `pi-tui`, replacing `*`. Installing against an older Pi now warns at install time instead of failing when a package uses an API that Pi release lacks. Pi Utils keeps its Pi peer optional.

## 0.2.1

### Patch Changes

- 2daa891: Bundled troubleshooting Skills no longer appear in the model's system prompt. Each now sets `disable-model-invocation: true`, so installing the package adds no per-turn context and you no longer need `skills` package filters to hide them. To open one, use `/skill:<package>` or a `$<package>` Skill Reference. Packages whose failures the model can see append that package's Skill path to configuration and runtime failures, so the model loads the guide only when one occurs.

## 0.2.0

### Minor Changes

- 706d063: Add package skills that guide Pi through extension configuration and diagnosis.
