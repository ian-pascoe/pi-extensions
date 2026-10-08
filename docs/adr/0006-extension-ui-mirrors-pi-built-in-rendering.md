# Extension UI mirrors Pi built-in rendering through shared pi-utils primitives

Every package renders its tool rows, custom messages, widgets, footer status, and panels so they read as part of the default Pi interface, not as a house style. Each tool copies its Nearest Built-in. Its header leads with the registered tool name in bold `toolTitle`, then the target in `accent`, then arguments in `muted`. Its Collapsed View uses that tool's preview length, so terminals follow bash (last 5 lines), searches and location lists follow grep (15), lists follow ls (20), reads follow read (header only on success), and everything else uses Pi's 10-line fallback. The Expand Hint uses Pi's wording, `... (N more lines, <key> to expand)`. While a tool runs it shows Pi's `Elapsed`/`Took` footer. Colours come only from the user's theme tokens. Model-facing tool output is unchanged, because this decision governs rendering only.

Pi exports `keyHint`, `keyText`, `truncateToVisualLines`, `renderDiff`, `DynamicBorder`, and its theme helpers, but not its tool-header or preview helpers. `@ian-pascoe/pi-utils` therefore owns one rendering module. It wraps the exported pieces and re-implements the rest to Pi's conventions, and every package uses it instead of local copies. The module also owns the Status Mark set, a tree-prefix helper using Pi's `├─ `/`└─ `/`│  `, the widget and footer-status layouts, the shared settings menu, and a token-tagging test theme that render tests use to prove theme compliance and width safety.

## Considered Options

- **A distinct house style for these extensions.** Rejected. Fifteen independently installed packages each looking unlike Pi, and unlike each other, was the problem being fixed.
- **Per-package conventions without a shared module.** Rejected. It produced five Expand Hint forms, four clip lengths, and conflicting status glyphs.
- **Runtime feature checks for newer Pi APIs.** Rejected in favour of raising every package's Pi peer floor to `>=1.1.0`, which provides `outputPad`, `durationMs`, and `registerToolRenderer` directly.

## Consequences

- Tool rows carry no Status Marks, because the Outcome Background already shows pending, success, and failure. Status Marks appear only on surfaces whose background does not show the outcome: widgets, footer status, overlay rows, and Guardian and Advisor entries. Todo Tasks keep `[ ]`/`[>]`/`[x]` checkboxes, modelled on Pi's settings selector, because the boxes show a Task's state rather than a tool outcome. Advisor severity is a Severity Label, never a Status Mark.
- Nerd Font icon variants are removed. Pi does not use them, and one Unicode set keeps every surface consistent.
- Custom messages and entries use Pi's default custom-message look: `customMessageBg` box, a Source Label line (`[subagents] result · worker → root · completed`, after Pi's `[skill] name`), and the 10-line Collapsed View.
- `·` with single spaces is the one inline separator, with one deliberate exception: overlay footer hint lines (`hintLine`) join their hints with two spaces, because that is how Pi's own selector draws its footer and that selector is the Nearest Built-in for the `/ps` and `/subagents` overlays.
- Overlays that need live updates and custom keys (`/ps`, `/subagents`) keep custom components but use Pi's selector frame. Existing `select`/`confirm`/`input`/`editor` dialogs are unchanged.
