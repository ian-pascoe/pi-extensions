# @ian-pascoe/pi-utils

## 0.6.0

### Minor Changes

- 7ab488c: Cap each observed tool result's text in Advisor's Review Evidence, in the Context Seed and in incremental updates, to its head and tail around an omission marker that points at the observed session file. The cap is the new `maxToolResultChars` setting (default 4,000 characters); the Tool-Call Reference and error status are kept, user and assistant text and reasoning are never capped, and the Context Seed fit and token calibration measure the capped evidence. `@ian-pascoe/pi-utils/evidence` gains an opt-in `toolResultCap` projection option (and `capText`); Guardian does not use it and is unchanged.
- eed4468: Add `@ian-pascoe/pi-utils/token-calibration`: `tokenFactor`, `calibratedFactor`, `fallbackTokenFactor`, and the `TokenSample` type, moved from Guardian. They learn a per-model multiple of Pi's chars/4 token estimate from the tokens a provider reports. `tokenFactor` also takes the caller's own fallback factor.
- 58a2ce1: Add `acceptNullForOptionalArguments` and `omitNullOptionalArguments` (`@ian-pascoe/pi-utils/null-optional-arguments`), which make a tool treat `null` for an optional parameter like omitting it by normalizing it in `prepareArguments`, and the `@ian-pascoe/pi-utils/tool-testing` helpers that prove it.

## 0.5.0

### Minor Changes

- 4ef1998: `@ian-pascoe/pi-utils/settings-menu` now exports one shared settings menu frame (`SettingsMenu`, `SettingsMenuUi`) for `/advisor` and `/guardian`, styled like Pi's settings screen, with `EditorChooser`, `scopeRow`, and `cycleDisplay`. Input errors use the `✗` Status Mark instead of `✖`.
- 4ef1998: Add shared extension UI primitives at `@ian-pascoe/pi-utils/ui`: `toolHeader`, `previewBody`, `CollapsedPreview`, `expandHint`, `summaryExpandHint`, `durationFooter`, `callDurationFooter`, `appendDurationFooter`, `statusMark`, `treePrefix`, `widgetLines`, `footerStatus`, `hintLine`, `joinInline`, `clipPlain`, `customMessageBox` (Pi's custom-message box under a bold `[source]` label with the heading on the same line, as Pi draws `[skill] name`) and `noticeText`, plus `expandMessageOnClick` and `expandEntryOnClick`, which let a click toggle a custom message or entry between its collapsed and expanded view as Pi's tool rows do. Each styles through the theme passed to it, so colours follow the user's theme.

  Add test tooling at `@ian-pascoe/pi-utils/ui-testing`: `taggedTheme` and `escapeTaggedTheme` (token-tagging themes; the second measures as zero columns so line breaks fall at real widths, though pi-tui does not re-open its styles after a wrap), `readableTags` to decode it, `expectLinesFitWidth`, which checks line width and rejects hard-coded colour escapes, and `expectClickToggles`, which proves a registered message or entry renderer swaps views on a click.

  Raise the Pi peer range to `>=1.1.0`.

  **Breaking:** remove `shouldUseNerdFontIcons` from the root export. Every surface now uses the shared Unicode Status Marks, and no package consumes it.

## 0.4.0

### Minor Changes

- ac8fb7a: Extract layered extension settings (`@ian-pascoe/pi-utils/layered-settings`) and evidence projection (`@ian-pascoe/pi-utils/evidence`) into pi-utils. Advisor and Minimal Subagents now build on them without changing behavior.
- 9b5cae5: Add `@ian-pascoe/pi-utils/settings-menu` (`ValueInput`, `ModelPicker`, `nextCycleValue`, `errorText`) and `@ian-pascoe/pi-utils/settings-command` (`parseSettingsCommand`, `completeSettingsCommandArguments`), the settings menu widgets and `/command [on|off|status|inherit|set] [--global|--project]` parsing that Advisor and Guardian shared by copy. `./settings-menu` needs the optional `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` peers. Advisor now uses them internally without changing behavior.

## 0.3.1

### Patch Changes

- 0ea1e75: Declare Pi `>=0.99.0` as the peer range for `@earendil-works/pi-coding-agent`, `pi-ai`, `pi-agent-core`, and `pi-tui`, replacing `*`. Installing against an older Pi now warns at install time instead of failing when a package uses an API that Pi release lacks. Pi Utils keeps its Pi peer optional.

## 0.3.0

### Minor Changes

- be50c8c: Add `stripControlCharacters` to `@ian-pascoe/pi-utils` and use it for transcript text sanitization in Context Management and Web Tools.
- be50c8c: Add `updateFileLocked` (`@ian-pascoe/pi-utils/locked-file-update`), which atomically updates a file under Pi's native settings lock. LSP and Minimal Subagents settings commands now share it.

## 0.2.0

### Minor Changes

- Add the `pi-agent-session-discovery` export for Advisor and CodeMode. Resolve native sessions against the host-supplied SDK class, including bundled CLI startup and reload.

## 0.1.1

### Patch Changes

- 291a3d2: Reduce duplicate TUI footer status and use compact Nerd Font-aware MCP and throughput indicators.
