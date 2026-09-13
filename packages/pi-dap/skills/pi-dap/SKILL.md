---
name: pi-dap
description: Configure or diagnose Pi DAP when acquisition or compatible .NET runtime selection fails, an Adapter Definition or Launch Profile fails, a Debug Session is stuck, or breakpoints do not bind.
license: MIT
---

# Pi DAP

1. Read [`../../README.md`](../../README.md)'s direct-script/compiled-program, Settings, and update sections. Identify whether an Explicit Definition or a Language Tool Preset owns the launch, and whether that preset's native platform is verified.
2. Call `dap` with `{"operation":"status"}`, then inspect settings warnings and retained adapter stderr.
3. Verify the selected adapter and Debuggee runtime independently, without launching. Check `dap.autoInstall` and null/quarantined settings before diagnosing a missing Managed Installation. For Deno inspect prepared dependencies and explicit permissions; for .NET inspect compiled runtimeconfig, symbols, architecture, and the documented supported runtime-policy boundary. Project builds/dependencies remain project-owned.
4. Classify the failure as settings, acquisition, adapter startup, protocol, state, timeout, or source mapping. For acquisition/update failures, retain the exact error; `/dap update [id]` is an explicit network action that only updates already installed managed presets.
5. For a requested change, edit one settings layer, validate JSON, and reload Pi.
6. With approval, run one representative launch. Finish when it reaches the expected Debug Session state or one exact adapter or protocol failure remains.

Ask before starting, pausing, stopping, or otherwise changing a Debuggee, and before initiating a Tool Update. An execution timeout may leave it running, so inspect `status` first. Cancel an interactive update with Escape; RPC clients use `/dap update cancel`, not the ordinary agent abort. Updates affect subsequent launches, not a live Debug Session.
