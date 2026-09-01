# @ian-pascoe/pi-minimal-subagents

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
