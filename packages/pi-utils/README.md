# Pi Utils

Shared runtime utilities for packages in [`ian-pascoe/pi-extensions`](https://github.com/ian-pascoe/pi-extensions).

## Nerd Font icons

`shouldUseNerdFontIcons()` enables Nerd Font icons for Kitty, Ghostty, WezTerm, and Herdr panes. Unknown terminals and ambiguous tmux or screen paths use portable text instead.

## Native Pi session discovery

Pi-hosted extensions can import `discoverPiAgentSession` from `@ian-pascoe/pi-utils/pi-agent-session-discovery` and call `discoverPiAgentSession(pi, AgentSession)` with `AgentSession` imported by the extension from `@earendil-works/pi-coding-agent`. Pi's loader resolves that class to the running host; importing it inside a compiled dependency can select a different SDK instance. Discovery captures the native synchronous `getAllTools` receiver and restores the exact prototype descriptor; callers remain responsible for capability checks.

## Optional peers by entrypoint

The Pi packages and `typebox` are optional peers; Pi's extension loader supplies them to Pi-hosted extensions, so install them yourself only outside Pi. The default entrypoint and `./locked-file-update` load none of them, so standalone terminal utilities can use them without Pi.

| Subpath                        | Needs at runtime                                                                 |
| ------------------------------ | -------------------------------------------------------------------------------- |
| `./pi-agent-session-discovery` | Nothing; the caller passes `AgentSession` from `@earendil-works/pi-coding-agent` |
| `./evidence`                   | `@earendil-works/pi-coding-agent` (`convertToLlm`, `estimateTokens`)             |
| `./layered-settings`           | `typebox`                                                                        |
| `./settings-menu`              | `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui`                   |
| `./settings-command`           | Nothing; its declarations reference `@earendil-works/pi-tui` types               |

Type-only imports from `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` are erased from the compiled JavaScript, but the published declarations reference them, so TypeScript consumers outside Pi need those packages installed to type-check.

## Locked file updates

`updateFileLocked(path, update, options)` from `@ian-pascoe/pi-utils/locked-file-update` reads, transforms, and atomically replaces a file under Pi's native settings lock (`proper-lockfile` with `realpath: false`), so extension writes to Pi settings files serialize with Pi's own writes. `update` receives the current text, or `undefined` when absent, and returns replacement text or `undefined` to leave the file unchanged. New files are created with mode `0o600`; existing modes are preserved unless `options.mode` forces one. Symlinked files are replaced at their target.

## Control characters

`stripControlCharacters(text)` normalizes CR and CRLF line breaks to LF and removes C0/C1 control characters except tabs and newlines. Pair it with Pi TUI's `stripTerminalSequences` before rendering untrusted text.

## Layered settings

`defineLayeredSettings({ namespace, label, schema, defaults, sessionEntryType?, merge? })` from `@ian-pascoe/pi-utils/layered-settings` manages one extension's options under a namespace key (for example `advisor`) in Pi's settings. `schema` is a TypeBox object whose properties are all optional (checked when defining); the authored options are `Static<typeof schema>`, and `defaults` must hold every option key with a compatible type unless the key has a `merge` hook. `label` names the extension in error messages. The returned functions read the global and trusted-project layers (`readLayers`, preserving per-scope errors), replay the selected branch's last `{ version: 1, overrides }` custom entry of `sessionEntryType` (`readOverrides`, present only when `sessionEntryType` is given), resolve effective settings and per-key sources by default < global < trusted project < session (`readSettings`), validate option keys (`optionKey`), and write one scope through Pi's private settings storage lock (`writeSettings`, after `flush()`; it refuses untrusted projects, unsupported backends, and documents it cannot safely rewrite). An optional per-key `merge` hook, `(current, next, source) => value`, merges a key across layers instead of replacing it, for example a record merged entry by entry.

Lower-level pieces are exported for consumers with their own validation or writer: `resolveLayeredOptions` is the pure layer fold (so lenient, warning-producing parsers can reuse it), and `rewriteNamespaceDocument` rewrites one namespace of a settings document's text (BOM stripping, object checks with caller-supplied errors, empty namespace removal) for use inside any lock, such as `updateFileLocked`.

## Settings menu widgets

`@ian-pascoe/pi-utils/settings-menu` holds the widgets behind an extension's `ctx.ui.custom` settings menu, built on Pi's native components. `ValueInput(title, hint, theme, submit, cancel)` is a single-line field whose `submit` may throw a user-facing message to show inline. `ModelPicker(models, choose, cancel)` is a fuzzy-searchable list of model names with `inherit` first. `nextCycleValue(values, current)` returns the next value of a cycled option, wrapping around. `errorText(cause)` is a thrown value's message. `theme` is a `SettingsMenuTheme`, the `fg` and `bold` methods of Pi's `Theme`. The rows, labels, and descriptions stay with the extension.

## Settings command parsing

`@ian-pascoe/pi-utils/settings-command` parses a `/command [on|off|status|inherit [key]|set <key> <JSON>] [--global|--project]` line. `parseSettingsCommand(input, spec)` returns `menu`, `status`, `set`, or `inherit` actions with the scope (`session` unless a flag names another). The `spec` supplies `usage`, `optionKey` and `parseOptions` (the validation, typically from `defineLayeredSettings`), `toggle(enabled)` (the key and patch for `on` and `off`), and optionally `parseExtra(text, scope)` for the command's own actions, tried first. `completeSettingsCommandArguments(prefix, spec)` completes the words, option keys after `set ` and `inherit `, optional `extra(prefix)` values, and the scope flags once the command parses at the `session` scope.

## Evidence projection

`@ian-pascoe/pi-utils/evidence` projects observed Pi messages to what the model received: `projectEvidence(messages)` (or `projectEvidenceItem(message)` for one) drops replay signatures, display details, provider metadata and native IDs, replaces images with attachment indexes, and links each tool call to its result with a stable `toolCallRef`. `evidenceRefs`, `evidenceTokens` (Pi's chars/4 estimate plus a per-image estimate), and `messageOrigins` (each message's role before Pi converted it) support consumers. `shortenEvidence(items, limit, marker)` and `fitEvidence(items, allowance, marker)` cap long texts and tool-call arguments, with the omission marker supplied by the caller; `evidenceItemsCost` and `combineEvidence` measure and join items.
