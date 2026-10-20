# Pi Utils

Shared runtime utilities for packages in [`ian-pascoe/pi-extensions`](https://github.com/ian-pascoe/pi-extensions).

## Shared extension UI

`@ian-pascoe/pi-utils/ui` holds the shared rendering primitives that tool rows, messages, widgets, and footer status use to read as part of the default Pi interface: `toolHeader`, `previewBody`, `CollapsedPreview`, `expandHint`, `summaryExpandHint`, `durationFooter`, `callDurationFooter`, `appendDurationFooter`, `statusMark`, `treePrefix`, `widgetLines`, `footerStatus`, `hintLine`, `joinInline`, `clipPlain`, `customMessageBox`, `noticeText`, and `expandMessageOnClick`/`expandEntryOnClick`, which wrap a custom message or entry renderer so a click toggles that item between its Collapsed and Expanded View, as Pi's tool rows and built-in messages do (Pi's custom-message and custom-entry hosts have no click handling of their own). A few packages still keep small local copies, listed as follow-ups in the PR. Every helper styles through the theme passed to it, never Pi's global theme, so colours always follow the user's theme. `@ian-pascoe/pi-utils/ui-testing` exports `taggedTheme`, which wraps each styled piece in its token name; `escapeTaggedTheme`, which encodes tokens as zero-width escapes (decode with `readableTags`) so line breaks fall where they would under a real theme, although pi-tui does not re-open its styles after a wrap; `expectLinesFitWidth`, which rejects hard-coded colour escapes and over-wide lines; and `expectClickToggles`, which proves a registered message or entry renderer swaps views on a click. The vocabulary is in [`GLOSSARY.md`](GLOSSARY.md) and the decision is [ADR 0006](../../docs/adr/0006-extension-ui-mirrors-pi-built-in-rendering.md).

Nerd Font icon support (`shouldUseNerdFontIcons`) was removed; every surface uses the shared Unicode Status Marks.

## Native Pi session discovery

Pi-hosted extensions can import `discoverPiAgentSession` from `@ian-pascoe/pi-utils/pi-agent-session-discovery` and call `discoverPiAgentSession(pi, AgentSession)` with `AgentSession` imported by the extension from `@earendil-works/pi-coding-agent`. Pi's loader resolves that class to the running host; importing it inside a compiled dependency can select a different SDK instance. Discovery captures the native synchronous `getAllTools` receiver and restores the exact prototype descriptor; callers remain responsible for capability checks.

## Optional peers by entrypoint

The Pi packages and `typebox` are optional peers; Pi's extension loader supplies them to Pi-hosted extensions, so install them yourself only outside Pi. The default entrypoint and `./locked-file-update` load none of them, so standalone terminal utilities can use them without Pi.

| Subpath                        | Needs at runtime                                                                 |
| ------------------------------ | -------------------------------------------------------------------------------- |
| `./pi-agent-session-discovery` | Nothing; the caller passes `AgentSession` from `@earendil-works/pi-coding-agent` |
| `./evidence`                   | `@earendil-works/pi-coding-agent` (`convertToLlm`, `estimateTokens`)             |
| `./token-calibration`          | Nothing                                                                          |
| `./agent-lineage`              | `typebox`                                                                        |
| `./secret-registry`            | Nothing                                                                          |
| `./queued-steer`               | Nothing                                                                          |
| `./layered-settings`           | `typebox`                                                                        |
| `./null-optional-arguments`    | `typebox`                                                                        |
| `./tool-testing`               | `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `typebox`        |
| `./settings-menu`              | `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui`                   |
| `./settings-command`           | Nothing; its declarations reference `@earendil-works/pi-tui` types               |
| `./ui`                         | `@earendil-works/pi-coding-agent` (`keyText`) and `@earendil-works/pi-tui`       |
| `./ui-testing`                 | `@earendil-works/pi-tui` (`visibleWidth`)                                        |

Type-only imports from `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` are erased from the compiled JavaScript, but the published declarations reference them, so TypeScript consumers outside Pi need those packages installed to type-check.

## Agent Lineage Records

`@ian-pascoe/pi-utils/agent-lineage` defines the session entry through which packages share where a Child Agent sits in its agent tree without depending on each other ([ADR-0007](../../docs/adr/0007-agent-lineage-record-in-pi-utils.md)). A package that creates child sessions appends `agentLineageRecord({ sessionId, rootSessionId, agentId, parentAgentId })` as a custom entry of type `AGENT_LINEAGE_ENTRY_TYPE`; `parentAgentId` is `null` when the parent is the root session. Readers call `readAgentLineage(sessionId, entries)` with a session's ID and its branch, or entries parsed from its file, and get the latest valid record that session wrote itself, or `undefined` when it has none. A record copied into another session, as Pi copies entries into a fork, is ignored until that session writes its own.

## Secret registry

`@ian-pascoe/pi-utils/secret-registry` is the process-wide registry of held Secrets that Pi Secret fills and other packages read without depending on it ([ADR-0008](../../docs/adr/0008-secret-redaction-registry-in-pi-utils.md)). Every copy of pi-utils in one process shares it. `holdSecret(name, value, owner, expiresAt?)` makes a value resolve under a Secret Name (`SECRET_NAME_PATTERN`) until the same `owner` calls `revokeSecret(name, owner)` or the wall clock passes `expiresAt`, so a late revocation timer cannot extend a Secret's life. `holdRefreshableSecret(name, owner, { refresh, value?, expiresAt? })` holds a Secret whose value lives elsewhere, such as in a Secret Provider: `refreshSecret(name)` awaits its `refresh` callback, keeps and returns the value read, and registers it for redaction, so Child Agents read the current value too ([ADR-0010](../../docs/adr/0010-secret-registry-refresh-callbacks.md)); for a Secret held without one it returns the held value. `resolveSecret(name)` and `heldSecretNames()` read what currently resolves, and `isSecretHeld(name)` is true for a held Secret even before its first read. `redactSecrets(value)` returns a copy of a JSON-like value with every value ever held in the process replaced by its Secret Reference (`secretReference(name)`, `{{secret:NAME}}`), longest value first in one pass, whether written as is or in a common encoding (JSON string escaping, percent-encoding, hex, and base64 and base64url at every alignment; only for values of at least `MIN_ENCODED_REDACTION_LENGTH`, 8, characters), or the value itself when nothing matched. Revoked and replaced values stay redacted for the rest of the process, so output printed after a Secret expires is still hidden.

## Queued Steers

`@ian-pascoe/pi-utils/queued-steer` is the process-wide signal that lets waiting tools end with a Steer Yield ([ADR-0009](../../docs/adr/0009-steer-yield-signal-in-pi-utils.md)). Pi hands a Queued Steer to an agent only after every tool call in the batch has returned, so a long wait would hold it back. Every copy of pi-utils in one process shares the signal, keyed by Pi session ID, so a package can raise it for a Child Agent session it runs in-process.

- `trackQueuedSteers(pi)` raises the signal for every steer queued through Pi's `input` event (`streamingBehavior: "steer"`, from the user, RPC, or `sendUserMessage`) and settles it at the next `turn_start` or `agent_end`. Each package that yields calls it on its own `pi`; a second call with the same `pi` does nothing. Follow-ups never raise it.
- `raiseQueuedSteer(sessionId)` records a steer a package sent itself, such as a custom message with `deliverAs: "steer"`. Pi gives extensions no way to see another extension's custom-message steers, so those cannot cause a Steer Yield.
- `hasQueuedSteer(sessionId)`, `onQueuedSteer(sessionId, listener)` (runs when a steer becomes pending), and `settleQueuedSteers(sessionId)` read and drive the signal directly.
- `watchQueuedSteer(sessionId)` returns `{ signal, dispose }` for one wait: an `AbortSignal` aborted once a steer is pending, at once when one already is. Call `dispose` when the wait ends.

A steer stays pending from when it is queued until Pi starts the next turn, so every wait that starts in between yields at once. An `input` handler that consumes the input still raises the signal, because Pi does not tell other handlers.

## Null for optional tool arguments

Models trained on tool schemas that declare an optional parameter as `T | null` pass `null` for "not given", while an extension's `Type.Optional(T)` rejects it. `acceptNullForOptionalArguments(tool)` from `@ian-pascoe/pi-utils/null-optional-arguments` returns the tool with a `prepareArguments` that drops those `null`s, so the call behaves as if the parameter were omitted. Every package registers its tools through it, so behaviour is identical everywhere:

```ts
pi.registerTool(acceptNullForOptionalArguments(tool));
```

Pi runs `prepareArguments` before schema validation, for model calls and for nested calls from codemode scripts (`tools.*`, `ctx.executeTool()`) alike. A `prepareArguments` the tool already has runs afterwards, on the normalized arguments, so a strict parser such as Pi DAP's sees omitted parameters, not `null`. Only `prepareArguments` is added: the schema, description, and every other field are unchanged, so the declaration the model sees and any provider prompt-cache prefix stay byte-identical.

Pi 1.1's own validation already drops a `null` for a top-level optional property whose schema rejects `null`, but only after `prepareArguments`, so strict parsers there still see it; it also skips union members (coercing `null` to `0` or `"null"`) and `$ref` properties. The helper closes those gaps and does not depend on that behaviour.

The rule, which `omitNullOptionalArguments(schema, args)` implements for the helper:

- A property is dropped only when its value is `null`, it is not `required`, and its own schema rejects `null`. Where `null` already means something, it stays: `Type.Union([T, Type.Null()])` (Todo's `description: null` removes a description), `Type.Unknown()`, and any schema that cannot be evaluated alone, such as a `$ref`.
- Nested optional properties are normalized as well: through object `properties`, array `items` and `prefixItems`, `allOf`, and `anyOf`/`oneOf` members. Models write `null` for a nested optional field (a breakpoint's `condition`, a finding's `evidence.refs`) as readily as for a top-level one, and a `null` the schema rejects can only fail the call. A union value that already satisfies a member is left alone; otherwise the first member whose normalized value validates is used.
- Record values (`additionalProperties`, `patternProperties`) are not rewritten: their entries are not optional parameters and dropping one would change which keys the tool receives.
- A `null` for a required property is never repaired; validation reports it as before.
- The arguments are never mutated, and the same object is returned when nothing changes.

`@ian-pascoe/pi-utils/tool-testing` holds the shared test helpers: `expectNullOptionalArgumentsOmitted(tool, args?, skip?)` proves every top-level optional parameter that rejects `null` behaves like omitting it (arguments default to a sample built from the schema), `recordToolRegistrations()` runs an extension factory against a recording stand-in for `ExtensionAPI`, `withoutPreparedArguments(factory)` registers the same tools without `prepareArguments` for a before/after comparison of what a real Pi session declares to the model, and `toolDeclarations(tools)` serializes ordered declarations for a byte comparison.

## Locked file updates

`updateFileLocked(path, update, options)` from `@ian-pascoe/pi-utils/locked-file-update` reads, transforms, and atomically replaces a file under Pi's native settings lock (`proper-lockfile` with `realpath: false`), so extension writes to Pi settings files serialize with Pi's own writes. `update` receives the current text, or `undefined` when absent, and returns replacement text or `undefined` to leave the file unchanged. New files are created with mode `0o600`; existing modes are preserved unless `options.mode` forces one. Symlinked files are replaced at their target.

## Control characters

`stripControlCharacters(text)` normalizes CR and CRLF line breaks to LF and removes C0/C1 control characters except tabs and newlines. Pair it with Pi TUI's `stripTerminalSequences` before rendering untrusted text.

## Layered settings

`defineLayeredSettings({ namespace, label, schema, defaults, sessionEntryType?, merge? })` from `@ian-pascoe/pi-utils/layered-settings` manages one extension's options under a namespace key (for example `advisor`) in Pi's settings. `schema` is a TypeBox object whose properties are all optional (checked when defining); the authored options are `Static<typeof schema>`, and `defaults` must hold every option key with a compatible type unless the key has a `merge` hook. `label` names the extension in error messages. The returned functions read the global and trusted-project layers (`readLayers`, preserving per-scope errors), replay the selected branch's last `{ version: 1, overrides }` custom entry of `sessionEntryType` (`readOverrides`, present only when `sessionEntryType` is given), resolve effective settings and per-key sources by default < global < trusted project < session (`readSettings`), validate option keys (`optionKey`), and write one scope through Pi's private settings storage lock (`writeSettings`, after `flush()`; it refuses untrusted projects, unsupported backends, and documents it cannot safely rewrite). An optional per-key `merge` hook, `(current, next, source) => value`, merges a key across layers instead of replacing it, for example a record merged entry by entry.

Lower-level pieces are exported for consumers with their own validation or writer: `resolveLayeredOptions` is the pure layer fold (so lenient, warning-producing parsers can reuse it), and `rewriteNamespaceDocument` rewrites one namespace of a settings document's text (BOM stripping, object checks with caller-supplied errors, empty namespace removal) for use inside any lock, such as `updateFileLocked`.

## Settings menu widgets

`@ian-pascoe/pi-utils/settings-menu` holds the widgets behind an extension's `ctx.ui.custom` settings menu, built on Pi's native components. `ValueInput(title, hint, theme, submit, cancel)` is a single-line field whose `submit` may throw a user-facing message to show inline. `ModelPicker(models, choose, cancel)` is a fuzzy-searchable list of model names with `inherit` first. `nextCycleValue(values, current)` returns the next value of a cycled option, wrapping around. `errorText(cause)` is a thrown value's message. `SettingsMenu` is the abstract frame behind `/advisor` and `/guardian`: a border, an accent title, themed status lines, Pi's native settings list (`setList(rows, onChange)`), an inline `✗` error, and a serialized edit queue (`run`, `settled`); a subclass supplies `headline()` and `refresh()`. `EditorChooser(ui, editorTitle, text, submit, inherit, cancel)` offers Pi's editor or `inherit` for a long text, `scopeRow(scope, scopes)` is the `Scope` row, and `cycleDisplay({ own, inEffect, source, scope })` with `effectiveWithSource(effective, source)` words a cycled option's value. `theme` is a `SettingsMenuTheme`, the `fg` and `bold` methods of Pi's `Theme`. The rows, labels, and descriptions stay with the extension.

## Settings command parsing

`@ian-pascoe/pi-utils/settings-command` parses a `/command [on|off|status|inherit [key]|set <key> <JSON>] [--global|--project]` line. `parseSettingsCommand(input, spec)` returns `menu`, `status`, `set`, or `inherit` actions with the scope (`session` unless a flag names another). The `spec` supplies `usage`, `optionKey` and `parseOptions` (the validation, typically from `defineLayeredSettings`), `toggle(enabled)` (the key and patch for `on` and `off`), and optionally `parseExtra(text, scope)` for the command's own actions, tried first. `completeSettingsCommandArguments(prefix, spec)` completes the words, option keys after `set ` and `inherit `, optional `extra(prefix)` values, and the scope flags once the command parses at the `session` scope.

## Token calibration

`@ian-pascoe/pi-utils/token-calibration` corrects Pi's chars/4 token estimate with what a model's provider reports, since JSON-heavy evidence tokenizes about 1.3–1.9× denser. `tokenFactor(samples, fallback?)` folds `{ estimated, reported }` samples in order into one factor per model; `calibratedFactor(current, estimated, reported)` is one step. The factor starts at `fallback` (default `fallbackTokenFactor`, 1.5), moves in steps of 0.25 between 1 and 3, and changes only when a sample's ratio leaves a hysteresis band, so a stable model keeps its evidence window and prompt cache; samples under 2,000 estimated tokens or without reported tokens are ignored. Callers choose where samples live: Guardian derives them from session entries, Advisor keeps them per observer. It loads no Pi package.

## Evidence projection

`@ian-pascoe/pi-utils/evidence` projects observed Pi messages to what the model received: `projectEvidence(messages)` (or `projectEvidenceItem(message)` for one) drops replay signatures, display details, provider metadata and native IDs, replaces images with attachment indexes, and links each tool call to its result with a stable `toolCallRef`. `evidenceRefs`, `evidenceTokens` (Pi's chars/4 estimate plus a per-image estimate), and `messageOrigins` (each message's role before Pi converted it) support consumers. `shortenEvidence(items, limit, marker)` and `fitEvidence(items, allowance, marker)` cap long texts and tool-call arguments, with the omission marker supplied by the caller; `evidenceItemsCost` and `combineEvidence` measure and join items. `projectEvidence` and `projectEvidenceItem` also accept `{ toolResultCap: { limit, marker } }`: each tool-result text longer than `limit` characters keeps its head and tail around the caller's `marker(omitted)` text (`capText(text, cap)`, also exported, does this for one string). Without the option nothing is shortened, so existing consumers such as Guardian are unchanged.
