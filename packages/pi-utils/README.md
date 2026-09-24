# Pi Utils

Shared runtime utilities for packages in [`ian-pascoe/pi-extensions`](https://github.com/ian-pascoe/pi-extensions).

## Nerd Font icons

`shouldUseNerdFontIcons()` enables Nerd Font icons for Kitty, Ghostty, WezTerm, and Herdr panes. Unknown terminals and ambiguous tmux or screen paths use portable text instead.

## Native Pi session discovery

Pi-hosted extensions can import `discoverPiAgentSession` from `@ian-pascoe/pi-utils/pi-agent-session-discovery` and call `discoverPiAgentSession(pi, AgentSession)` with `AgentSession` imported by the extension from `@earendil-works/pi-coding-agent`. Pi's loader resolves that class to the running host; importing it inside a compiled dependency can select a different SDK instance. Discovery captures the native synchronous `getAllTools` receiver and restores the exact prototype descriptor; callers remain responsible for capability checks.

Only this SDK-specific entrypoint requires the optional Pi coding-agent peer. The default entrypoint remains usable by standalone terminal utilities without loading Pi.

## Locked file updates

`updateFileLocked(path, update, options)` from `@ian-pascoe/pi-utils/locked-file-update` reads, transforms, and atomically replaces a file under Pi's native settings lock (`proper-lockfile` with `realpath: false`), so extension writes to Pi settings files serialize with Pi's own writes. `update` receives the current text, or `undefined` when absent, and returns replacement text or `undefined` to leave the file unchanged. New files are created with mode `0o600`; existing modes are preserved unless `options.mode` forces one. Symlinked files are replaced at their target.

## Control characters

`stripControlCharacters(text)` normalizes CR and CRLF line breaks to LF and removes C0/C1 control characters except tabs and newlines. Pair it with Pi TUI's `stripTerminalSequences` before rendering untrusted text.
