---
"@ian-pascoe/pi-termctrl": patch
---

Terminal edge cases now fail loudly and cheaply. `terminal_send` with `text` or `keys` to an exited Terminal returns an error naming its exit code or signal instead of silently dropping the input; a poll still returns the final screen. `terminal_stop` on an exited Terminal whose screen is unchanged since the agent's last result omits the screen and returns only its state and exit code or signal. `terminal_start` with a `cwd` that is missing or not a directory fails with an error naming the resolved path instead of termctrl's opaque "canonicalize session working directory" message.
