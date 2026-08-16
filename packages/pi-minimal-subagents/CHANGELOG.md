# @ian-pascoe/pi-minimal-subagents

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
