# @ian-pascoe/pi-utils

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
