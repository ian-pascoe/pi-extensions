---
name: pi-formatter
description: Configure or diagnose Pi Formatter when selection is skipped or conflicting, a tool cannot install, formatting targets the wrong file/root, or an update fails or needs cancellation.
license: MIT
---

# Pi Formatter

1. Read [`../../README.md`](../../README.md), especially Built-in formatters, Settings and explicit choices, and Acquisition, progress, and updates.
2. Capture one mutation's destination path, effective settings scope/trust, startup warning, and formatter warning. Establish whether an Explicit Definition owns the path before investigating a preset.
3. For an Explicit Definition, check its selector, Activation Gate, root, environment, and `$FILE` mode. A matching different-ID definition suppresses defaults even if its gate skips or command fails; same-ID null/invalid entries also shadow built-ins.
4. For a preset, inspect the nearest parsed Formatter Markers, including nested packages. Resolve same-directory conflicts with an explicit choice. Generic manifests and substring mentions are not preferences. For Rust, check Cargo edition/workspace inheritance and native rustfmt config precedence.
5. Identify the selected external tool and runtime before inspecting `<Pi agent directory>/managed-tools`. `formatter.autoInstall: false` allows existing copies without acquiring a helper; do not change PATH, install project dependencies, or invoke ambient mise to repair managed state.
6. For a requested Tool Update, run `/formatter update [id]` and capture old/new, no-change, or per-tool failure. It updates installed managed presets only, even in Installed-only Mode. Terminal Escape cancels; RPC/headless hosts can invoke `/formatter update cancel`. Wait for cleanup before retrying.
7. For a settings change, edit one trusted settings layer, validate JSON, reload Pi, and repeat the original mutation. Marker-only changes apply on the next mutation without reload.
8. Finish when the same destination formats or the exact preference, selector, activation, root, runtime, acquisition, cancellation, timeout, or exit boundary is evidenced. Verify later LSP diagnostics see the formatted file when both extensions are loaded.

A formatter/acquisition failure warns but preserves the original successful mutation. First-use
formatting is awaited, not a background job. Explicit failing commands are never replaced silently.
