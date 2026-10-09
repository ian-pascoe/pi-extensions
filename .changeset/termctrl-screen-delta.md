---
"@ian-pascoe/pi-termctrl": minor
---

Terminal results now send a Screen Delta: when the rows above the previous result's cursor row are unchanged, the text shows only the rows from there down, and a `terminal_send` whose screen is unchanged shows no rows. Every result reports the cursor (`cursor row:col` or `cursor hidden`, and `cursor` in the structured result), the structured `screen` is always the whole screen, `screen_from_row` marks a Screen Delta, and `terminal_send` gains `full_screen` to show every row.
