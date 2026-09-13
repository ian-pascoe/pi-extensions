# @ian-pascoe/pi-minimal-subagents

## 0.9.0

### Minor Changes

- f27ee9e: Add Pi Advisor review sessions, scoped configuration, safe intervention scheduling, and Minimal Subagents integration. Share native AgentSession discovery through `pi-utils`; refactor CodeMode to use the shared capture helper. Resolve discovery against the running host's SDK class, including bundled CLI startup and reload, rather than a compiled dependency's separate SDK instance. Add native Advisor argument autocomplete for commands, settings keys, and scope flags. Recreate Pi 0.85.1's built-in inline llama.cpp extension from its shipped file so actual CLI reviews settle before and after reload, while unsupported inline resources still fail closed. Recognize both verified native auth-storage class names in Pi's bundled CLI and SDK so file-backed OAuth keeps native refresh and locking rather than being misclassified as custom storage.

## 0.8.0

### Minor Changes

- d17acac: Add configurable base, read, and modify toolsets using CodeMode-compatible minimatch patterns. Presets accumulate without duplication, optional tools warn rather than blocking launches, and existing child capability contracts remain unchanged. Recognize Pi's native PowerShell tool and preserve CodeMode-only exposure within child capability ceilings.

## 0.7.2

### Patch Changes

- d07a898: Restore Child Agent metadata and validate saved sessions without eagerly starting child runtimes or their extension services. Open only recipients that need new work, and inspect saved delivery evidence without starting runtimes to prevent duplicate replay.
- 87bfb13: Preserve existing active-tool order during MCP catalogue refreshes and Subagent Access reconciliation to avoid unnecessary prompt-cache invalidation. Append only newly active tools while retaining capability removal and Coordinator Tool deduplication.

## 0.7.1

### Patch Changes

- 461d335: Snapshot agents in registry creation records so later live-agent mutations cannot invalidate in-memory replay or trigger cascading invalid-record warnings.

## 0.7.0

### Minor Changes

- 8dbcc8c: Better subagents UI

### Patch Changes

- be638f6: Update dependencies

## 0.6.6

### Patch Changes

- 1a2e2b9: Remove lint workarounds from package code

## 0.6.5

### Patch Changes

- 8e665f5: Preserve custom fixed-name tool rendering when Pi reloads extensions.

## 0.6.4

### Patch Changes

- 229ea22: Expose tools registered after CodeMode starts, including tools loaded by Pi MCP, without widening Child Agent Launch Contracts.

## 0.6.3

### Patch Changes

- 89e1007: Replace the complete read-tool preset with pi-codex-conversion's native shell tools in Child Agent runtimes.

## 0.6.2

### Patch Changes

- 291a3d2: Reduce duplicate TUI footer status and use compact Nerd Font-aware MCP and throughput indicators.

## 0.6.1

### Patch Changes

- d89b4ea: Queue parent messages into active child turns without racing a second prompt.

## 0.6.0

### Minor Changes

- 33923bb: Add `/subagents` for branch, global, and trusted-project Subagent Access controls plus live Child Agent status, configured Child Agent extensions, and capability-bounded runtime tool adapters.

## 0.5.0

### Minor Changes

- 841a7df: Add bounded CodeMode tool discovery and typed tool result schemas across supporting extensions.

## 0.4.0

### Minor Changes

- 706d063: Add package skills that guide Pi through extension configuration and diagnosis.

## 0.3.0

### Minor Changes

- ea05c8e: Return detailed child status from timed-out waits and expose bounded recent activity with live reasoning, message text, and tool work.

## 0.2.3

### Patch Changes

- b5f7aeb: Batch queued coordination messages and terminal results so recipients process all available subagent output in one model turn.

## 0.2.2

### Patch Changes

- ba02ae7: Keep automatic fallback after intermediate wait messages, drain queued messages with an already settled terminal result, and steer unclaimed messages and results into active recipient turns.

## 0.2.1

### Patch Changes

- 00e8819: Refactor AI overengineering

## 0.2.0

### Minor Changes

- 370efb2: Deliver child coordination messages through active waits before queuing them in
  Pi, keep later messages on a wait-claimed turn ahead of its terminal result,
  defer fallback while the recipient is active, and suppress automatic terminal
  delivery after a successful wait. Preserve completed outcomes across compaction
  and fix fork clone session identity and provenance. Clarify bundled versus exact
  ordinary-tool selection.
- 370efb2: Persist sequenced Coordination Message delivery and exact turn waits across lifecycle changes, introduce a pure bounded Delivery Ledger, write fully validated Registry V2 records with V1 migration and semantic diagnostics, scope state and evidence to the active branch, make multi-generation forks cancellation-safe and clone-session-owned, verify child session provenance, prune deleted message projections, and isolate malformed persistence and restoration failures.

## 0.1.1

### Patch Changes

- 43a8625: Support preferred thinking-level suffixes in Minimal Subagents model roles.
- 7bc3308: Show live Child Agent Runtime Profiles in coordinator status and the transient Subagents widget.
