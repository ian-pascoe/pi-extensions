---
"@ian-pascoe/pi-termctrl": minor
"@ian-pascoe/pi-minimal-subagents": minor
"@ian-pascoe/pi-dap": minor
---

Waiting tools end early with a Steer Yield when a steer is queued, so the user's or parent agent's message reaches the agent without waiting for the tool batch to finish. Agent `bash` calls move to the background as with Ctrl+B. `terminal_wait` returns `reason: "steered"` (renamed from `"message"`, and follow-ups no longer end it). `terminal_start` and `terminal_send` settle with `settle_reason: "steered"`. `subagent_wait` returns `event: "steered"` with the timeout progress snapshot. Pi DAP execution waits report `running (wait steered)` with `execution_wait_steered`. A parent's Coordination Message to a busy Child Agent counts as a steer in that child.
