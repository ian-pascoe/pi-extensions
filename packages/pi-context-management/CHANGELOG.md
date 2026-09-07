# @ian-pascoe/pi-context-management

## 0.1.0

### Minor Changes

- 81eb9c1: Replace the exact Pi version restriction with runtime capability checks for checkpoint, session, budget, and trusted-settings APIs. Preserve fail-closed behavior when required capabilities are missing or lost. Allow passive compaction listeners, including inactive Autoresearch, while cancelling actual competing summaries before persistence and preventing native summarizer fallback.

## 0.0.0

### Initial Release

- Add session-native Notes, selected-branch History retrieval, agent-owned Rollover, budget safeguards, and native Context Checkpoints for Pi 0.85.1.
