---
"@ian-pascoe/pi-termctrl": minor
---

Terminal results no longer repeat lines the agent already saw. A line from an earlier result's screen is skipped when it scrolls off unchanged; a line rewritten since, such as a progress line or a prompt the agent typed at, still arrives in its final form. Scrolled-off lines in `terminal_start`, `terminal_send` and `terminal_stop` results are now limited by the new `termctrl.scrollback` setting (default 100 lines or 16 KB): past it, the result keeps the first and last lines with a `[… N lines omitted …]` line between them, and `full_output_path` names a file holding every line. Set `scrollback` to `false` or `0` to keep only Pi's 2000-line or 50 KB limit on the whole result. `output_missing` is unchanged.
