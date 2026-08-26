---
name: pi-minimal-subagents
description: Configure or diagnose Pi Minimal Subagents for spawn, capability, delivery, wait, restore, reload, or fork failures.
license: MIT
---

# Pi Minimal Subagents

1. Read the relevant spawn, capability, delivery, or recovery section of [`../../README.md`](../../README.md).
2. From the direct parent, use `subagent_status` to capture the Child Agent's Launch Contract, Runtime Profile, dependencies, result, and Recent Activity.
3. Classify the fault as launch resolution, adjacency, ordinary-tool ceiling, delivery state, or Registry recovery.
4. For configuration changes, identify the effective layer, make one scoped edit, validate JSON, and reload Pi.
5. Repeat the same spawn or coordination operation. Finish when it succeeds or one named launch, adjacency, capability, delivery, or recovery boundary is evidenced.

A wait timeout observes without cancelling. Tool arrays contain only ordinary tools. Cancellation preserves a Child Session; deletion removes it.
