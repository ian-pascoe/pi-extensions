---
"@ian-pascoe/pi-utils": minor
---

Add shared extension UI primitives at `@ian-pascoe/pi-utils/ui`: `toolHeader`, `previewBody`, `CollapsedPreview`, `expandHint`, `summaryExpandHint`, `durationFooter`, `callDurationFooter`, `appendDurationFooter`, `statusMark`, `treePrefix`, `widgetLines`, `footerStatus`, `hintLine`, `joinInline`, `clipPlain`, `customMessageBox` and `noticeText`. Each styles through the theme passed to it, so colours follow the user's theme.

Add test tooling at `@ian-pascoe/pi-utils/ui-testing`: `taggedTheme` and `escapeTaggedTheme` (token-tagging themes; the second measures as zero columns so line breaks fall at real widths, though pi-tui does not re-open its styles after a wrap), `readableTags` to decode it, and `expectLinesFitWidth`, which checks line width and rejects hard-coded colour escapes.

Raise the Pi peer range to `>=1.1.0`.

**Breaking:** remove `shouldUseNerdFontIcons` from the root export. Every surface now uses the shared Unicode Status Marks, and no package consumes it.
