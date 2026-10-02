---
"@ian-pascoe/pi-context-management": minor
---

Register `context_rollover` with Pi's `model-only` tool exposure, so Pi itself keeps `codemode` scripts and `ctx.executeTool()` callers from running it instead of relying on description prose and a runtime check. The tool stays declared to the model under both `codemode.mode` values; in `only` mode it was previously hidden behind the `codemode` listing, where scripts could not use it, and is now declared directly. Its description no longer says "never call it from a codemode script" and, under `codemode.mode: "on"`, loses the `Codemode: tools.context_rollover(args)` suffix Pi would append, so the model-facing tool definition changes once on upgrade. Ordering of the other tool definitions is unchanged. The sole-direct-call batch check stays.
