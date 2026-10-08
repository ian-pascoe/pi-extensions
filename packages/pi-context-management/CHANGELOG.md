# @ian-pascoe/pi-context-management

## 0.4.1

### Patch Changes

- Updated dependencies [ac8fb7a]
- Updated dependencies [9b5cae5]
  - @ian-pascoe/pi-utils@0.4.0

## 0.4.0

### Minor Changes

- afd1bcc: `context_history` list previews now describe each entry's content, search previews are readable text, and `list`/`search` accept optional `type` and `role` filters.

## 0.3.0

### Minor Changes

- bf36a67: `context_history`, `context_notes`, and `context_rollover` now declare MCP-style tool `annotations`, all closed-world. `context_history` is read-only; `context_notes` and `context_rollover` are not read-only but are non-destructive and not idempotent, because they append to the session journal and earlier values stay readable through History. Pi reports the hints through `pi.getAllTools()` for permission extensions. Annotations are not sent to model providers, so tool declarations, the system prompt, and the prompt cache prefix are unchanged.
- 0ea1e75: These packages now require Pi `>=0.99.0`, raised from an undeclared (`*`) peer range and a documented floor of `0.84.1` or `0.85.1`. Pi 0.99.0 is the first release that provides the tool exposure, output schema, and built-in extension APIs the repository uses, so the packages no longer carry fallbacks for older hosts.

  Advisor no longer probes the Pi SDK for missing exports and methods at load. It no longer pauses with "this Pi runtime lacks ..." diagnostics, because the peer range guarantees those members. Minimal Subagents always gives Child Agents Pi's built-in `codemode`, `tool-search`, and `mcp` extensions instead of skipping any the host lacked. Termctrl's `bash` replacement now requires Pi's `bash` to declare an object `outputSchema`, which Pi provides from 0.99.0, instead of silently falling back to an empty schema.

- d13aaf1: Register `context_rollover` with Pi's `model-only` tool exposure, so Pi itself keeps `codemode` scripts and `ctx.executeTool()` callers from running it instead of relying on description prose and a runtime check. The tool stays declared to the model under both `codemode.mode` values; in `only` mode it was previously hidden behind the `codemode` listing, where scripts could not use it, and is now declared directly. Its description no longer says "never call it from a codemode script" and, under `codemode.mode: "on"`, loses the `Codemode: tools.context_rollover(args)` suffix Pi would append, so the model-facing tool definition changes once on upgrade. Ordering of the other tool definitions is unchanged. The sole-direct-call batch check stays.
- 98b14ae: `context_notes` and `context_history` now declare an `outputSchema` and return `structuredContent` built from the same serialization as their JSON text. A Pi `codemode` script receives the parsed object with snake_case fields (for example `read.total_characters` or `windows.next_offset`) instead of a JSON string it had to parse. The model-facing JSON text (camelCase), persisted session `details`, and error behavior are unchanged, and `context_rollover` is untouched because it cannot run inside a script. Scripts that called `JSON.parse` on these results must use the object directly and its snake_case field names. Pi appends a one-line result summary to each tool's description once.

### Patch Changes

- Updated dependencies [0ea1e75]
  - @ian-pascoe/pi-utils@0.3.1

## 0.2.6

### Patch Changes

- 2daa891: Bundled troubleshooting Skills no longer appear in the model's system prompt. Each now sets `disable-model-invocation: true`, so installing the package adds no per-turn context and you no longer need `skills` package filters to hide them. To open one, use `/skill:<package>` or a `$<package>` Skill Reference. Packages whose failures the model can see append that package's Skill path to configuration and runtime failures, so the model loads the guide only when one occurs.

## 0.2.5

### Patch Changes

- feea7eb: Describe nested Rollover rejection in terms of Pi's built-in `codemode` scripts now that `@ian-pascoe/pi-codemode` is retired.
- be50c8c: Add `stripControlCharacters` to `@ian-pascoe/pi-utils` and use it for transcript text sanitization in Context Management and Web Tools.
- Updated dependencies [be50c8c]
- Updated dependencies [be50c8c]
  - @ian-pascoe/pi-utils@0.3.0

## 0.2.4

### Patch Changes

- e6620c4: Coexist with summarizer overrides such as `pi-claude-bridge`. Manual and threshold compaction are claimed before other hooks run, and another hook's overflow summary is replaced by the Emergency Rollover with a warning rather than stopping Context Management. Direct `context_rollover` checkpoints now emit Pi's `session_compact` event so provider session caches rebuild from the new Context Window.

  Fix every compaction failing with "compaction result missing or replaced" on Pi 0.87, which stores a wrapper for each `pi.on` handler. Context Management no longer finds its own compaction hook by function identity.

## 0.2.3

### Patch Changes

- 98e967c: Pause after manually requested Context Rollovers while preserving automatic continuation for threshold and overflow paths.

## 0.2.2

### Patch Changes

- 3f18c1e: Use Pi's native compaction accounting, triggers, and recent-history retention instead of separate budget estimates and thresholds. Normal automatic and manual compaction now requests fresh Notes and an agent-written Handoff before Rollover; actual overflow retains immediate saved-state recovery. Report unfinished preparation without repeated reminders or stale fallback, and ignore obsolete `contextManagement` settings with one migration warning per session load.

## 0.2.1

### Patch Changes

- 1a2e2b9: Remove lint workarounds from package code

## 0.2.0

### Minor Changes

- 3a1bf68: Stream Note writes/appends and Rollover Handoffs in the transcript. Collapsed previews follow the newest text within eight rendered lines, remain visible after completion, and expand to show the full content.

### Patch Changes

- 873d8f7: Remove the UTF-16 length counter from Note and History read headings while preserving pagination metadata in expanded output.

## 0.1.0

### Minor Changes

- 81eb9c1: Replace the exact Pi version restriction with runtime capability checks for checkpoint, session, budget, and trusted-settings APIs. Preserve fail-closed behavior when required capabilities are missing or lost. Allow passive compaction listeners, including inactive Autoresearch, while cancelling actual competing summaries before persistence and preventing native summarizer fallback.

## 0.0.0

### Initial Release

- Add session-native Notes, selected-branch History retrieval, agent-owned Rollover, budget safeguards, and native Context Checkpoints for Pi 0.85.1.
