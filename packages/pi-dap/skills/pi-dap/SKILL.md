---
name: pi-dap
description: Configure or diagnose Pi DAP when an Adapter Definition or Launch Profile fails, a Debug Session is stuck, or breakpoints do not bind.
license: MIT
---

# Pi DAP

1. Read [`../../README.md`](../../README.md)'s Settings section and identify the effective Adapter Definition and Launch Profile.
2. Call `dap` with `{"operation":"status"}`, then inspect settings warnings and retained adapter stderr.
3. Verify the configured command and referenced files without launching.
4. Classify the failure as settings, adapter startup, protocol, state, timeout, or source mapping.
5. For a requested change, edit one settings layer, validate JSON, and reload Pi.
6. With approval, run one representative launch. Finish when it reaches the expected Debug Session state or one exact adapter or protocol failure remains.

Ask before starting, pausing, stopping, or otherwise changing a Debuggee. An execution timeout may leave it running, so inspect `status` first.
