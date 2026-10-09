---
name: pi-termctrl
description: Configure or diagnose Pi Termctrl when Terminal tools are missing, the bash replacement conflicts with another extension, Background jobs misbehave, or termctrl settings need changing.
license: MIT
disable-model-invocation: true
---

# Pi Termctrl

1. Read [`../../README.md`](../../README.md)'s Settings and Platform sections, then identify the effective `termctrl` settings scope.
2. If `terminal_start` is missing, check the startup diagnostic. Confirm the platform has a packaged `termctrl` binary or that `TERMCTRL_BINARY` names an executable one.
3. If `bash` lacks the `background` parameter, check `termctrl.replaceBash` and look for another extension that also registers `bash`.
4. Call `terminal_list` to inspect live and exited Terminals and Background jobs. Ask the user to open `/ps` for a live preview.
5. If `bash` results are shorter than expected, check `termctrl.bashTail` (default 300 lines or 16 KB; `false` restores Pi's limits); the result's notice names the limits and the file holding every line. If a Terminal result's `scrolled_off` shows `[… N lines omitted …]`, check `termctrl.scrollback` (default 100 lines or 16 KB) the same way.
6. If a Terminal result shows only some screen rows, that is a Screen Delta: the rows above the previous result's cursor row are unchanged, `screen_from_row` names the first row shown, and `screen` holds the whole screen. Pass `full_screen: true` to `terminal_send` to see every row, and read `cursor` (or `cursor hidden`) in the first line to find the input position.
7. Classify the failure as settings, binary resolution, `bash` conflict, cap, or process behaviour.
8. For a requested change, edit one settings layer, validate its JSON, and reload Pi. Finish when the expected tools appear or one exact cause remains.

Ask before stopping a Terminal or Background job you did not start.
