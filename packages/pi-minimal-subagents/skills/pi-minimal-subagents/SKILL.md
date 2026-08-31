---
name: pi-minimal-subagents
description: Configure or diagnose Pi Minimal Subagents for Subagent Access, missing Coordinator Tools, spawn, capability, delivery, wait, restore, reload, or fork failures.
license: MIT
---

# Pi Minimal Subagents

1. Read the relevant access, spawn, capability, delivery, or recovery section of [`../../README.md`](../../README.md).
2. For Subagent Access or missing Root Agent Coordinator Tools, run `/subagents status` first and record the effective source plus actual active-tool count.
3. From the direct parent, use `subagent_status` to capture the Child Agent's Launch Contract, Runtime Profile, dependencies, result, and Recent Activity.
4. Classify the fault as Subagent Access, launch resolution, adjacency, ordinary-tool ceiling, delivery state, or Registry recovery.
5. For access changes, use the narrowest `/subagents enable|disable|reset` scope. For other configuration, identify the effective layer, make one scoped edit, validate JSON, and reload Pi.
6. Repeat the same spawn or coordination operation. Finish when it succeeds or one named access, launch, adjacency, capability, delivery, or recovery boundary is evidenced.

A wait timeout observes without cancelling. Tool arrays contain only ordinary tools. Cancellation preserves a Child Session; deletion removes it.
