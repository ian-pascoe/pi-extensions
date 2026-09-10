# @ian-pascoe/pi-context-management

## 0.2.2

### Patch Changes

- 3f18c1e: Use Pi's native compaction accounting, triggers, and recent-history retention instead of separate budget estimates and thresholds. Normal automatic and manual compaction now requests fresh Notes and an agent-written Handoff before Rollover; actual overflow retains immediate saved-state recovery. Report unfinished preparation without repeated reminders or stale fallback, and ignore obsolete `contextManagement` settings with one migration warning per session load.

## 0.2.1

### Patch Changes

- 1a2e2b9: Remove lint workarounds from package code

## 0.2.0

### Minor Changes

- 3a1bf68: Stream Note writes/appends and Rollover Handoffs in the transcript. Collapsed previews follow the newest text within eight rendered lines, remain visible after completion, and expand to show the full content.

### Patch Changes

- 873d8f7: Remove the UTF-16 length counter from Note and History read headings while preserving pagination metadata in expanded output.

## 0.1.0

### Minor Changes

- 81eb9c1: Replace the exact Pi version restriction with runtime capability checks for checkpoint, session, budget, and trusted-settings APIs. Preserve fail-closed behavior when required capabilities are missing or lost. Allow passive compaction listeners, including inactive Autoresearch, while cancelling actual competing summaries before persistence and preventing native summarizer fallback.

## 0.0.0

### Initial Release

- Add session-native Notes, selected-branch History retrieval, agent-owned Rollover, budget safeguards, and native Context Checkpoints for Pi 0.85.1.
