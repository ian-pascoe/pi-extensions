# Pi Utils

Shared runtime utilities for packages in [`ian-pascoe/pi-extensions`](https://github.com/ian-pascoe/pi-extensions).

## External Deno executables

`resolveDenoExecutable(candidate)` reads known npm/pnpm Deno entrypoints, including
npm aliases identified by their published package name, without executing repair wrappers. It returns the existing package-local native
payload, or the matching installed optional `@deno` payload. Missing candidates or
incomplete recognized installations return `undefined`; unrelated opaque commands
are unchanged. Callers retain ordered discovery and private-acquisition policy,
and must continue to later candidates when an earlier installation is incomplete.
No files are installed, copied, or chmodded. Explicit Definitions need not use it.

## Nerd Font icons

`shouldUseNerdFontIcons()` enables Nerd Font icons for Kitty, Ghostty, WezTerm, and Herdr panes. Unknown terminals and ambiguous tmux or screen paths use portable text instead.

## Native Pi session discovery

Pi-hosted extensions can import `discoverPiAgentSession` from `@ian-pascoe/pi-utils/pi-agent-session-discovery` and call `discoverPiAgentSession(pi, AgentSession)` with `AgentSession` imported by the extension from `@earendil-works/pi-coding-agent`. Pi's loader resolves that class to the running host; importing it inside a compiled dependency can select a different SDK instance. Discovery captures the native synchronous `getAllTools` receiver and restores the exact prototype descriptor; callers remain responsible for capability checks.

Only this SDK-specific entrypoint requires the optional Pi coding-agent peer. The default entrypoint remains usable by standalone terminal utilities without loading Pi.
