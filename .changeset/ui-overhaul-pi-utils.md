---
"@ian-pascoe/pi-utils": minor
---

Add shared extension UI primitives at `@ian-pascoe/pi-utils/ui` (tool headers, Collapsed and Expanded View previews, Pi's Expand Hint, live `Elapsed`/`Took` footers, Status Marks, tree prefixes, widget and footer-status layouts) and a token-tagging test theme with a width and hard-coded-colour check at `@ian-pascoe/pi-utils/ui-testing`. Raise the Pi peer range to `>=1.1.0`.

**Breaking:** remove `shouldUseNerdFontIcons` from the root export. Every surface now uses the shared Unicode Status Marks, and no package consumes it.
