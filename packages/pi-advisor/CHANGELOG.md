# @ian-pascoe/pi-advisor

## 0.7.0

### Minor Changes

- 4ef1998: Advisor now follows Pi's built-in rendering: `advisor_ask` shows a lowercase `advisor_ask` header, a ten-line Markdown answer with Pi's expand hint, and an `Elapsed`/`Took` footer. Interventions and status entries use Pi's custom-message box under an `[advisor]` label with a coloured severity word (`[advisor] concern`) or the state (`[advisor] ● on`) and expand or collapse when clicked, the footer reads `● advisor on`, warnings are prefixed `Advisor:`, and the `/advisor` menu uses the shared settings menu. Requires Pi 1.1.0 or newer.

### Patch Changes

- Updated dependencies [4ef1998]
- Updated dependencies [4ef1998]
  - @ian-pascoe/pi-utils@0.5.0

## 0.6.1

### Patch Changes

- ac8fb7a: Extract layered extension settings (`@ian-pascoe/pi-utils/layered-settings`) and evidence projection (`@ian-pascoe/pi-utils/evidence`) into pi-utils. Advisor and Minimal Subagents now build on them without changing behavior.
- 9b5cae5: Add `@ian-pascoe/pi-utils/settings-menu` (`ValueInput`, `ModelPicker`, `nextCycleValue`, `errorText`) and `@ian-pascoe/pi-utils/settings-command` (`parseSettingsCommand`, `completeSettingsCommandArguments`), the settings menu widgets and `/command [on|off|status|inherit|set] [--global|--project]` parsing that Advisor and Guardian shared by copy. `./settings-menu` needs the optional `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` peers. Advisor now uses them internally without changing behavior.
- Updated dependencies [ac8fb7a]
- Updated dependencies [9b5cae5]
  - @ian-pascoe/pi-utils@0.4.0

## 0.6.0

### Minor Changes

- a9baf5c: Enabling Advisor partway through a long session no longer sends the entire conversation to its first Review or Consultation. The new `seedBudgetTokens` setting (default `auto`, a quarter of the Advisor model's context window) bounds that first context. It always keeps the observed system prompt, tool summaries, original request, and newest turn, then the newest turns that fit, shortening oversized text with a marker. It tells the Advisor which observed messages it kept and where granted tools can find the rest. After a cancelled Consultation, the next Review or Consultation now receives the full context again instead of only newer messages.
- 4c2ee84: Advisor findings are now fresher, grounded, and fewer. A Review's findings are no longer delivered when the observed agent completed more turns before they arrived; the next Review re-validates them against those newer turns and reports only those that still apply, without an extra model call. Findings are held back at most once: when the agent also outruns the Review that re-validates them, that Review's Concerns and Blockers, including new ones, are delivered anyway and its Nits are dropped, so Concerns and Blockers still arrive while the agent keeps working. Every finding must now name a concrete defect in completed work and cite its evidence, a tool call's short `ref` or a verbatim quote: the default Advisor Prompt asks for this, `advisor_report` requires an `evidence` field, and findings that cite nothing or a `ref` the Advisor was never given are dropped. After two invalid `advisor_report` calls a Review now ends without findings instead of retrying until its deadline, and one invalid call that the Advisor corrects no longer pauses it. Advice about what to do next is left to `advisor_ask` consultations. The new `maxNitsPerRequest` setting (default 3) limits the Nits delivered per request; Concerns and Blockers are never capped. `/advisor status` shows findings awaiting re-validation and counts dropped findings by reason.
- 92c19cf: Advisor Reviews can now cost less. The new `reviewEvery` setting reviews after every turn (`"turn"`, the default), after every N turns and when the request completes, or once per request (`"request"`); a turn with a failed tool call is still reviewed at once, and each Review covers every turn not yet reviewed. The new `maxSessionTokens` setting (default `auto`, half the Advisor model's context window, at most 200k tokens) compacts the private Advisor Session with Pi's native compaction after a Review that leaves it larger, so later Reviews stop re-reading an ever-growing history; delivered findings, deferred Concerns, and incremental evidence carry on unchanged. `/advisor status` now shows the last Review's cost and the running total of Reviews, including any compaction they ran, and shows unknown cost as unknown; expanded, it shows each Child Agent's Review cost. A failed or timed-out compaction does not pause the Advisor; the next Review starts a fresh Advisor Session from a Context Seed.

  Headless final drains and Minimal Subagents task completion now wait for final Reviews up to one Review deadline (`reviewTimeoutMs`, 120 seconds by default) instead of 30 seconds, so a Review covering a whole request is not dropped. A Review already running when the observed session compacts now finishes and delivers its findings instead of being discarded. When the evidence a Review would add exceeds `seedBudgetTokens`, the Advisor Session is rebuilt from a Context Seed within that budget.

  The `auto` `seedBudgetTokens` is now at most 100k tokens (still a quarter of the window for windows up to 400k), so an automatic Context Seed fits well within the automatic Advisor Session cap. Both ceilings keep Advisors on 1M-token models from re-reading a ~500k-token session on every Review, which was measured costing at least $0.12 per Review that found nothing; set either value explicitly to use more of a large window.

### Patch Changes

- aa6407d: Advisor Reviews and Consultations now receive only what the observed model saw, which makes Advisor prompts much smaller and cheaper. Replay signatures, display-only tool `details`, provider metadata, and native IDs are no longer sent. Each tool call and its result share a short reference, and observed tools are listed by name and one-line summary instead of full descriptions and schemas.
- bf536ee: The Advisor's system prompt no longer carries the skills catalogue, including skills contributed by inherited extensions, which Reviews and Consultations never use. This shrinks the prompt and keeps skill changes from churning the Advisor's cache.

## 0.5.0

### Minor Changes

- 602fd00: Replace the Advisor's JSON dumps with readable TUI rendering and add a settings menu:

  - In the interactive TUI, `/advisor` alone opens a settings menu built from Pi's native settings list, like `/settings`. It shows the live Advisor state, writes edits immediately to the selected scope (session, trusted project, or global), edits the prompt in Pi's own editor component, and offers Resume while paused. Closing it records one status entry listing the changes. Without the TUI, `/advisor` records status as before; `/advisor status` always does.
  - Status entries show a compact summary (state, model, backlog, usage and cost, unavailable tools, last error), with every setting, its source, and each Child Agent when expanded. Entries from configuration changes lead with the changes they applied, such as `✓ model → provider/id [session]`.
  - Interventions render with severity styling and Advisor attribution, and Child Agent findings carry the child's label. Long Nits collapse; Concerns and Blockers always show in full.
  - `advisor_ask` shows its question and a Markdown answer preview.
  - An enabled Advisor shows its state and Review Backlog in the footer.
  - `/advisor set` with an unknown key now reports `Unknown Advisor option: <key>`.

  Rendering is UI-only: model-visible Intervention content, tool declarations, and the system prompt are unchanged. Older status entries keep their state and error.

## 0.4.0

### Minor Changes

- bf36a67: `advisor_ask` now declares MCP-style tool `annotations` (read-only, non-destructive, idempotent, closed-world), and the Advisor Session's internal `advisor_report` tool declares non-destructive, closed-world annotations, so permission extensions inherited by either session no longer fall back to the pessimistic defaults. Pi reports them through `pi.getAllTools()` and does not send them to model providers, so tool declarations, the system prompt, and the prompt cache prefix are unchanged.
- 0ea1e75: These packages now require Pi `>=0.99.0`, raised from an undeclared (`*`) peer range and a documented floor of `0.84.1` or `0.85.1`. Pi 0.99.0 is the first release that provides the tool exposure, output schema, and built-in extension APIs the repository uses, so the packages no longer carry fallbacks for older hosts.

  Advisor no longer probes the Pi SDK for missing exports and methods at load. It no longer pauses with "this Pi runtime lacks ..." diagnostics, because the peer range guarantees those members. Minimal Subagents always gives Child Agents Pi's built-in `codemode`, `tool-search`, and `mcp` extensions instead of skipping any the host lacked. Termctrl's `bash` replacement now requires Pi's `bash` to declare an object `outputSchema`, which Pi provides from 0.99.0, instead of silently falling back to an empty schema.

### Patch Changes

- 0c82034: Stop declaring granted `codemode` and `deferred` tools, including MCP tools, to the Advisor model. Pi's `tools` option activated every granted tool, so the Advisor request carried script-only tools in its tool list. They now stay callable from granted `codemode` scripts and can still be declared through `tool_search`, as for Minimal Subagents Child Agents.
- Updated dependencies [0ea1e75]
  - @ian-pascoe/pi-utils@0.3.1

## 0.3.5

### Patch Changes

- b15f4fd: Advisor Sessions now reproduce the observed agent's codemode `models` API from the resource owner's recreation inputs, so an Advisor watching a Minimal Subagents Child Agent no longer gives its scripts a `models` API the child lacks.

## 0.3.4

### Patch Changes

- 2daa891: Bundled troubleshooting Skills no longer appear in the model's system prompt. Each now sets `disable-model-invocation: true`, so installing the package adds no per-turn context and you no longer need `skills` package filters to hide them. To open one, use `/skill:<package>` or a `$<package>` Skill Reference. Packages whose failures the model can see append that package's Skill path to configuration and runtime failures, so the model loads the guide only when one occurs.

## 0.3.3

### Patch Changes

- feea7eb: Drop the `@ian-pascoe/pi-codemode` integration in favor of Pi's built-in `codemode`. `advisor_ask` availability now changes only the active tool set, and Advisor Sessions pause only when the advice tool is inactive after extension binding; built-in `codemode.mode: "only"` keeps granted tools active and callable from scripts.
- be50c8c: Drop the Pi version gate. Advisor now checks the Pi SDK exports and methods it uses, and verifies after binding that its tool ceiling admits no ungranted tools. An unmet requirement warns the user, hides `advisor_ask`, and leaves the Advisor unavailable or paused with the missing requirements in `/advisor status`, without disrupting the observed session. Advisor pauses also raise a warning notification.
- Updated dependencies [be50c8c]
- Updated dependencies [be50c8c]
  - @ian-pascoe/pi-utils@0.3.0

## 0.3.2

### Patch Changes

- 8a928a5: Support Pi 0.99.1. Advisor's version gate now targets 0.99.1. Advisor Sessions recreate the observed session's enabled `builtin:<name>` extensions in their observed order: `codemode`, `tool-search`, and `mcp` from Pi's exported factories, and `llama.cpp` from Pi's shipped extension file. Built-ins disabled with `-builtin:<name>` stay absent, and a host factory registered under a built-in name pauses the Advisor instead of being replaced.

## 0.3.1

### Patch Changes

- e6620c4: Support Pi 0.87.1. Advisor's version gate now targets 0.87.1. Observed provider contexts now take the current system prompt and tool declarations from the transcript system messages that Pi 0.87 sends in place of top-level `systemPrompt`/`tools`.

## 0.3.0

### Minor Changes

- e7a6648: Add non-interrupting Nit findings and configurable multi-finding Reviews with severity-aware deduplication.

## 0.2.0

### Minor Changes

- 9f19c43: Add blocking `advisor_ask` consultations through the existing private Advisor Session, with serialized passive review, accurate backlog accounting, cancellation safety, and dynamic main-agent visibility.

  Preserve CodeMode-only tool requests when another extension changes one registered tool's availability.

## 0.1.0

### Minor Changes

- f27ee9e: Add Pi Advisor review sessions, scoped configuration, safe intervention scheduling, and Minimal Subagents integration. Share native AgentSession discovery through `pi-utils`; refactor CodeMode to use the shared capture helper. Resolve discovery against the running host's SDK class, including bundled CLI startup and reload, rather than a compiled dependency's separate SDK instance. Add native Advisor argument autocomplete for commands, settings keys, and scope flags. Recreate Pi 0.85.1's built-in inline llama.cpp extension from its shipped file so actual CLI reviews settle before and after reload, while unsupported inline resources still fail closed. Recognize both verified native auth-storage class names in Pi's bundled CLI and SDK so file-backed OAuth keeps native refresh and locking rather than being misclassified as custom storage.
