# Detect Queued Steers through a shared signal in pi-utils

Pi hands a Queued Steer to an agent only after every tool call in the batch has returned, so waiting tools in `pi-termctrl`, `pi-minimal-subagents`, and `pi-dap` end early with a Steer Yield. They need one rule for "a Queued Steer is pending for this session", so `@ian-pascoe/pi-utils` owns a process-wide, per-session steer signal that each package can raise and read without requiring another. A Queued Steer stays pending from when it is queued until Pi starts the next turn.

## Considered Options

- **`ctx.hasPendingMessages()` alone.** It counts follow-ups, which must not end a wait, and misses every custom-message steer.
- **Per-package detection.** Each package would see only the steers it sends itself, and `pi-termctrl` in a Child Agent session would never learn of the parent's Coordination Message.

## Consequences

Pi 1.2 and 1.3 give extensions no way to observe a custom message queued as a steer, whether through `pi.sendMessage` or `agent.steer()`, until the tool batch has returned. The signal therefore covers user steers, seen through the `input` event, and steers sent by this repository's packages, which raise it when they send. A third-party extension's steer cannot cause a Steer Yield until Pi counts custom steers in `hasPendingMessages()` or exposes a queue event; we will ask upstream for one. `codemode` is Pi's built-in and cannot detach a running script, so it gets no Steer Yield of its own: our tools called from a script yield individually and the script continues.
