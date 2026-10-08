# @ian-pascoe/pi-minimal-subagents

## 0.17.0

### Minor Changes

- 4ef1998: Coordinator tool rows, agent messages, the `pi-minimal-subagents` widget, the `/subagents` panel, and notices now follow Pi's built-in rendering: lowercase tool-name headers, the Expand Hint, an `Elapsed`/`Took` footer, Status Marks with Pi's tree prefixes, Pi's selector frame, and `Subagents:` warning and error notices. Agent messages and results open with a `[subagents] result · worker → root · completed` label line and expand or collapse when clicked. Requires Pi `>=1.1.0`.

### Patch Changes

- Updated dependencies [4ef1998]
- Updated dependencies [4ef1998]
  - @ian-pascoe/pi-utils@0.5.0

## 0.16.1

### Patch Changes

- ac8fb7a: Extract layered extension settings (`@ian-pascoe/pi-utils/layered-settings`) and evidence projection (`@ian-pascoe/pi-utils/evidence`) into pi-utils. Advisor and Minimal Subagents now build on them without changing behavior.
- Updated dependencies [ac8fb7a]
- Updated dependencies [9b5cae5]
  - @ian-pascoe/pi-utils@0.4.0

## 0.16.0

### Minor Changes

- 29c58b0: **Behavior change:** Child Agents that cannot spawn now get only `agent_message`, dropping the unusable `subagent_wait` and `subagent_status` definitions from every child request (child CodeMode scripts lose those two tools). Fanout children below the depth cap keep all six Coordinator Tools; a fanout child at the cap now gets only `agent_message`.

### Patch Changes

- 3043858: `subagent_wait` and `subagent_status` now round `usage.cost` fields to six decimal places of USD in their text and `structuredContent`, so results no longer show float-noise tails such as `0.000022999999999999997`.

## 0.15.0

### Minor Changes

- 583f0ae: **Behavior change:** `subagent_wait` timeouts now return a compact progress snapshot (`state`, `elapsed_ms`, `latest_activity_at`, `total_tokens`, `recent_activity_labels`) instead of the full child `agent` status, and `latest_activity_at` advances while a child works.

### Patch Changes

- 8015e0e: The duplicate agent ID error now names the existing child's state and suggests `agent_message`, `subagent_delete`, or another `agent_id`.

## 0.14.1

### Patch Changes

- 87f1be6: A default `subagent_wait` no longer hands back a result that was already delivered automatically: it returns `already_delivered: true` with the turn identity and status, and `turn_id` rereads the full result.

## 0.14.0

### Minor Changes

- 8359f6f: `subagent` now accepts an optional `role` naming a configured model role (`minimalSubagents.modelRoles`), so the agent no longer translates each role into `model` and `thinking_level` by hand. The role resolves to its model and, when it has a suffix, its thinking level; an explicit `model` or `thinking_level` overrides the role's value, and an unknown role fails before any child is created, listing the configured role names. The Launch Contract records the resolved model and thinking level plus the `role` used, and `subagent_status` and the expanded `subagent` result show it; Registry V2 persists `role` as an optional Launch Contract field, so existing sessions and V1 records load unchanged. `role` is a plain string, not an enum of the configured names, so the tool definition stays byte-identical when `modelRoles` changes; only the role list in the system prompt changes, and only at reload.

### Patch Changes

- a29888e: A child result queued to the root is no longer lost when Pi discards the queued message before the model sees it, for example when Esc interrupts the root turn. At the root's next turn boundary with nothing left in Pi's queue, a queued result without Delivery Evidence becomes selectable by a default `subagent_wait` again, together with any Coordination Messages batched into it. Automatic fallback re-sends it ahead of newer results: into the same run when the queue was cleared without an abort, or after Esc when the root's next run starts. It never starts a root turn by itself, so Esc stays respected. A result the root already received is settled instead, so it is never delivered twice. An automatic hand-off whose grace period spans a session branch change is now abandoned without disturbing the selected branch's replay, which decides delivery.
- a8cfbf9: `subagent_wait` without `turn_id` now skips turns whose terminal result you already claimed or that was already delivered to you automatically. After waiting on a child's first result and sending `agent_message` (which reports `started-turn` with a new `turn_id`), `subagent_wait({ agent_id })` targets the new turn, both while it runs and after it is cancelled, instead of returning the first result again. It selects the oldest remaining observable turn, then the active turn, then the latest turn; settled turns you have neither claimed nor received are still returned oldest first, and an explicit `turn_id` still addresses any retained turn, claimed or not. Delivery Ledger persistence and automatic fallback are unchanged.
- a8cfbf9: A `subagent_wait` timeout is no longer treated as Delivery Evidence for the waited-on turn's final result. Before, after a wait timed out on a running turn, the root session held a wait tool result for that turn, so reconciliation settled the later automatic result as delivered without it ever reaching the parent. Timeout results now count like intermediate message results: only a wait that returned the turn's terminal result, or the automatic result message itself, proves delivery.

## 0.13.0

### Minor Changes

- 354c4cf: Fix rough edges found by using the coordinator tools:

  - **Behavior change:** `session_context` now defaults to `omit`, so a new child starts without the parent's conversation. Pass `session_context: "inherit"` (or `"compact"`) to keep the previous behavior. Inheriting copied the whole parent conversation without prompt-cache reuse and let children mistake the parent's requests for their own. The `task` and `session_context` descriptions now ask for a self-contained brief and explain the trade-off. Existing Child Agents keep the mode recorded in their Launch Contracts.

  - A child that inherits or compacts its parent's conversation now receives it quoted, as one user-role `minimal-subagents.parent-context` message per parent message, instead of replaying the parent's assistant turns as its own. Tool calls and results become text, custom messages keep their `customType` in the label, incomplete (errored, aborted, or length-limited) parent turns are marked, and images are kept. Parent reasoning, system prompt, and tool declarations are omitted. Its task follows as an explicit handoff. This keeps the parent's turns distinct from the child's own, rather than guaranteeing that a child ignores the quoted requests. The Launch Contract still records the unframed task.
  - `subagent` runs sequentially, so a `subagent_wait` or `agent_message` in the same tool batch can target the new child instead of failing with `unknown agent`.
  - `subagent` returns a compact result: `agent_id`, `turn_id`, `status`, the resolved `model`, `thinking_level`, `tools`, and `delegation`, plus any tool-resolution `warnings`. The full Child Agent detail remains available through `subagent_status` and the transcript renderer.
  - `agent_message` to an idle child reports `disposition: "started-turn"` with the new `turn_id` to wait on, instead of `queued`. Tool descriptions explain how to continue an idle child.
  - The Root Agent can inspect any descendant with `subagent_status`. Model-facing status no longer reports an empty `children` array next to a non-zero `child_count`.
  - `subagent_cancel` lists in `affected_agent_ids` only agents whose active turns it cancelled.
  - Reported `usage` always includes `cacheWrite1h` and `reasoning`.
  - Clearer errors: an unavailable tool lists the permitted ordinary tools, an unknown `turn_id` suggests omitting it, and reusing a deleted agent ID asks for a different `agent_id`.
  - Coordinator tool rendering shows content without expanding: a `subagent` call shows its launch settings and task, a waiting `subagent_wait` shows the child's tool-call count and its latest work on a tree rail, rendered with Pi's own message and tool components, a settled wait previews the child's output (or error) with cost, and automatic agent results preview as Markdown. Long text shows its first 10 lines; Pi's tool-expansion key shows the rest.
  - The `/subagents` panel keeps its background behind truncated lines, including the ellipsis, padding, and border.

## 0.12.0

### Minor Changes

- 0ea1e75: These packages now require Pi `>=0.99.0`, raised from an undeclared (`*`) peer range and a documented floor of `0.84.1` or `0.85.1`. Pi 0.99.0 is the first release that provides the tool exposure, output schema, and built-in extension APIs the repository uses, so the packages no longer carry fallbacks for older hosts.

  Advisor no longer probes the Pi SDK for missing exports and methods at load. It no longer pauses with "this Pi runtime lacks ..." diagnostics, because the peer range guarantees those members. Minimal Subagents always gives Child Agents Pi's built-in `codemode`, `tool-search`, and `mcp` extensions instead of skipping any the host lacked. Termctrl's `bash` replacement now requires Pi's `bash` to declare an object `outputSchema`, which Pi provides from 0.99.0, instead of silently falling back to an empty schema.

- 89de8d5: A partially failed `subagent_delete` and a failed `agent_message` delivery now return an error result that keeps the tool's declared structured output, instead of throwing (`subagent_delete`) or reporting success (`agent_message`). The model still sees an error, and the troubleshooting Skill pointer stays in the error text. Codemode scripts now receive the `deleted_agent_ids`, `trashed_session_files`, and `failures` of a partial deletion, or the `disposition` and `error` of a failed delivery, where a thrown error used to reject the call with no data. The transcript renderer shows the partial deletion's details, including its failures, rather than falling back to plain error text.
- bf36a67: The coordinator tools now declare MCP-style tool `annotations`, reported through `pi.getAllTools()` for permission extensions. `subagent` is destructive and open-world because a Child Agent can use any tool it is granted; `agent_message` is non-destructive and closed-world; `subagent_status` and `subagent_wait` are read-only; `subagent_cancel` is non-destructive and idempotent; `subagent_delete` is destructive and idempotent. Annotations are not sent to model providers, so tool declarations, the system prompt, and the prompt cache prefix are unchanged.

### Patch Changes

- 3e882f3: Update the toolset example for Pi DAP's per-operation tools: grant them with the `dap_*` pattern.
- Updated dependencies [0ea1e75]
  - @ian-pascoe/pi-utils@0.3.1

## 0.11.0

### Minor Changes

- b15f4fd: Load Pi's built-in llama.cpp extension in Child Agents, honoring `-builtin:llama.cpp`, so children can use llama.cpp models; when Pi's llama.cpp file is unavailable, a llama.cpp launch model is reported as a missing dependency. A reopened child now re-declares the tools it last declared, including tools loaded through `tool_search`, keeping its prompt cache stable. Child `codemode` scripts no longer get a `models` API that could call models outside the Launch Contract, and observers such as the Advisor receive that setting in the child's recreation inputs.

## 0.10.1

### Patch Changes

- 2daa891: Bundled troubleshooting Skills no longer appear in the model's system prompt. Each now sets `disable-model-invocation: true`, so installing the package adds no per-turn context and you no longer need `skills` package filters to hide them. To open one, use `/skill:<package>` or a `$<package>` Skill Reference. Packages whose failures the model can see append that package's Skill path to configuration and runtime failures, so the model loads the guide only when one occurs.

## 0.10.0

### Minor Changes

- 1a7c706: Support Pi's built-in `codemode`, `tool_search`, and MCP in Child Agents. Children load the built-in extensions the root has enabled, an omitted tool selection inherits the caller's Reachable Tools (including `codemode`- and `deferred`-exposed tools such as MCP tools), granted script-only tools stay undeclared, and coordinator tools return `structuredContent` so scripts receive objects. Closing a child runtime now emits `session_shutdown` so child extensions release services such as MCP server connections.

### Patch Changes

- be50c8c: Add `updateFileLocked` (`@ian-pascoe/pi-utils/locked-file-update`), which atomically updates a file under Pi's native settings lock. LSP and Minimal Subagents settings commands now share it.
- feea7eb: Collapse the child tool policy to one layer now that `@ian-pascoe/pi-codemode` is retired in favor of Pi's built-in `codemode`.
- Updated dependencies [be50c8c]
- Updated dependencies [be50c8c]
  - @ian-pascoe/pi-utils@0.3.0

## 0.9.0

### Minor Changes

- f27ee9e: Add Pi Advisor review sessions, scoped configuration, safe intervention scheduling, and Minimal Subagents integration. Share native AgentSession discovery through `pi-utils`; refactor CodeMode to use the shared capture helper. Resolve discovery against the running host's SDK class, including bundled CLI startup and reload, rather than a compiled dependency's separate SDK instance. Add native Advisor argument autocomplete for commands, settings keys, and scope flags. Recreate Pi 0.85.1's built-in inline llama.cpp extension from its shipped file so actual CLI reviews settle before and after reload, while unsupported inline resources still fail closed. Recognize both verified native auth-storage class names in Pi's bundled CLI and SDK so file-backed OAuth keeps native refresh and locking rather than being misclassified as custom storage.

## 0.8.0

### Minor Changes

- d17acac: Add configurable base, read, and modify toolsets using CodeMode-compatible minimatch patterns. Presets accumulate without duplication, optional tools warn rather than blocking launches, and existing child capability contracts remain unchanged. Recognize Pi's native PowerShell tool and preserve CodeMode-only exposure within child capability ceilings.

## 0.7.2

### Patch Changes

- d07a898: Restore Child Agent metadata and validate saved sessions without eagerly starting child runtimes or their extension services. Open only recipients that need new work, and inspect saved delivery evidence without starting runtimes to prevent duplicate replay.
- 87bfb13: Preserve existing active-tool order during MCP catalogue refreshes and Subagent Access reconciliation to avoid unnecessary prompt-cache invalidation. Append only newly active tools while retaining capability removal and Coordinator Tool deduplication.

## 0.7.1

### Patch Changes

- 461d335: Snapshot agents in registry creation records so later live-agent mutations cannot invalidate in-memory replay or trigger cascading invalid-record warnings.

## 0.7.0

### Minor Changes

- 8dbcc8c: Better subagents UI

### Patch Changes

- be638f6: Update dependencies

## 0.6.6

### Patch Changes

- 1a2e2b9: Remove lint workarounds from package code

## 0.6.5

### Patch Changes

- 8e665f5: Preserve custom fixed-name tool rendering when Pi reloads extensions.

## 0.6.4

### Patch Changes

- 229ea22: Expose tools registered after CodeMode starts, including tools loaded by Pi MCP, without widening Child Agent Launch Contracts.

## 0.6.3

### Patch Changes

- 89e1007: Replace the complete read-tool preset with pi-codex-conversion's native shell tools in Child Agent runtimes.

## 0.6.2

### Patch Changes

- 291a3d2: Reduce duplicate TUI footer status and use compact Nerd Font-aware MCP and throughput indicators.

## 0.6.1

### Patch Changes

- d89b4ea: Queue parent messages into active child turns without racing a second prompt.

## 0.6.0

### Minor Changes

- 33923bb: Add `/subagents` for branch, global, and trusted-project Subagent Access controls plus live Child Agent status, configured Child Agent extensions, and capability-bounded runtime tool adapters.

## 0.5.0

### Minor Changes

- 841a7df: Add bounded CodeMode tool discovery and typed tool result schemas across supporting extensions.

## 0.4.0

### Minor Changes

- 706d063: Add package skills that guide Pi through extension configuration and diagnosis.

## 0.3.0

### Minor Changes

- ea05c8e: Return detailed child status from timed-out waits and expose bounded recent activity with live reasoning, message text, and tool work.

## 0.2.3

### Patch Changes

- b5f7aeb: Batch queued coordination messages and terminal results so recipients process all available subagent output in one model turn.

## 0.2.2

### Patch Changes

- ba02ae7: Keep automatic fallback after intermediate wait messages, drain queued messages with an already settled terminal result, and steer unclaimed messages and results into active recipient turns.

## 0.2.1

### Patch Changes

- 00e8819: Refactor AI overengineering

## 0.2.0

### Minor Changes

- 370efb2: Deliver child coordination messages through active waits before queuing them in
  Pi, keep later messages on a wait-claimed turn ahead of its terminal result,
  defer fallback while the recipient is active, and suppress automatic terminal
  delivery after a successful wait. Preserve completed outcomes across compaction
  and fix fork clone session identity and provenance. Clarify bundled versus exact
  ordinary-tool selection.
- 370efb2: Persist sequenced Coordination Message delivery and exact turn waits across lifecycle changes, introduce a pure bounded Delivery Ledger, write fully validated Registry V2 records with V1 migration and semantic diagnostics, scope state and evidence to the active branch, make multi-generation forks cancellation-safe and clone-session-owned, verify child session provenance, prune deleted message projections, and isolate malformed persistence and restoration failures.

## 0.1.1

### Patch Changes

- 43a8625: Support preferred thinking-level suffixes in Minimal Subagents model roles.
- 7bc3308: Show live Child Agent Runtime Profiles in coordinator status and the transient Subagents widget.
