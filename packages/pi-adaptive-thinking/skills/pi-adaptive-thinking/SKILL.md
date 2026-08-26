---
name: pi-adaptive-thinking
description: Configure or diagnose pi-adaptive-thinking when thinking-level tools are missing or session levels behave unexpectedly.
license: MIT
---

# Pi Adaptive Thinking

1. Read [`../../README.md`](../../README.md)'s Configuration and Behavior sections. Stop when you can name the expected tool names, precedence rule, and reset behavior.
2. Inspect extension-load errors and both documented configuration layers. Identify the effective source or exact parse failure.
3. Verify the registered names, then call the status tool once. Classify the symptom as configuration, unsupported model level, baseline state, no-op, consecutive setter rejection, or expected reset.
4. For a requested change, edit the intended layer, keep `guidance` static, validate JSON, and reload Pi.
5. Finish when the effective source and registered names are known and the status evidence matches the expected behavior after reload.
