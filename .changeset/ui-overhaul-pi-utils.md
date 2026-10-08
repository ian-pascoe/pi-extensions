---
"@ian-pascoe/pi-utils": minor
---

Add shared extension UI primitives at `@ian-pascoe/pi-utils/ui`: `toolHeader`, `previewBody`, `CollapsedPreview`, `expandHint`, `summaryExpandHint`, `durationFooter`, `callDurationFooter`, `appendDurationFooter`, `statusMark`, `treePrefix`, `widgetLines`, `footerStatus`, `hintLine`, `joinInline`, `clipPlain`, `customMessageBox` and `noticeText`. Each styles through the theme passed to it, so colours follow the user's theme.

Add test tooling at `@ian-pascoe/pi-utils/ui-testing`: `taggedTheme` and `escapeTaggedTheme` (token-tagging themes; the second measures as zero columns so components wrap at real widths), `readableTags` to decode it, and `expectLinesFitWidth`, which checks line width and rejects hard-coded colour escapes.

Share one settings-menu frame (`SettingsMenu`, `EditorChooser`, `scopeRow`) for the Advisor and Guardian menus. Raise the Pi peer range to `>=1.1.0`.

**Breaking:** remove `shouldUseNerdFontIcons` from the root export. Every surface now uses the shared Unicode Status Marks, and no package consumes it.
