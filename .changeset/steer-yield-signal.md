---
"@ian-pascoe/pi-utils": minor
---

Add `@ian-pascoe/pi-utils/queued-steer`, a process-wide, per-session Queued Steer signal that lets waiting tools end with a Steer Yield. `trackQueuedSteers(pi)` raises it for user steers and settles it when Pi starts the next turn, `raiseQueuedSteer(sessionId)` records steers a package sends itself, and `watchQueuedSteer(sessionId)` gives one wait an `AbortSignal` that aborts on a pending steer.
