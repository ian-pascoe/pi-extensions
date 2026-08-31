# Add the `/subagents` Command

**Status:** Implemented

## Outcome

Add a Root Agent command that controls branch-scoped **Subagent Access**, persists global or trusted-project defaults, and opens a live read-only Child Agent status view. Preserve every existing Child Agent, Launch Contract, Registry, Delivery Ledger, and result-delivery behavior.

Read before implementation:

- [`../../AGENTS.md`](../../AGENTS.md) for repository instructions.
- [`../../CONTEXT-MAP.md`](../../CONTEXT-MAP.md), [`../../packages/pi-minimal-subagents/CONTEXT.md`](../../packages/pi-minimal-subagents/CONTEXT.md), and every package ADR in [`../../packages/pi-minimal-subagents/docs/adr/`](../../packages/pi-minimal-subagents/docs/adr/) for canonical language and branch semantics.
- [`../../packages/pi-minimal-subagents/src/minimal-subagents-extension.ts`](../../packages/pi-minimal-subagents/src/minimal-subagents-extension.ts) for lifecycle ordering and Root Agent tool registration.
- [`../../packages/pi-minimal-subagents/src/minimal-subagents-config.ts`](../../packages/pi-minimal-subagents/src/minimal-subagents-config.ts) for trust-aware global/project configuration.
- [`../../packages/pi-minimal-subagents/src/minimal-subagents-ui.ts`](../../packages/pi-minimal-subagents/src/minimal-subagents-ui.ts) for the existing widget and timer ownership.
- [`../../packages/pi-minimal-subagents/src/minimal-subagents-context.ts`](../../packages/pi-minimal-subagents/src/minimal-subagents-context.ts) and [`../../packages/pi-minimal-subagents/src/minimal-subagents-sessions.ts`](../../packages/pi-minimal-subagents/src/minimal-subagents-sessions.ts) for Recent Activity and raw Child Agent messages.
- Pi's [command, active-tool, and custom-UI extension APIs](../../.repos/pi/packages/coding-agent/docs/extensions.md), [`/tools` branch-state example](../../.repos/pi/packages/coding-agent/examples/extensions/tools.ts), and [settings persistence implementation](../../.repos/pi/packages/coding-agent/src/core/settings-manager.ts).
- Pi's exported [`AssistantMessageComponent`](../../.repos/pi/packages/coding-agent/src/modes/interactive/components/assistant-message.ts), [`ToolExecutionComponent`](../../.repos/pi/packages/coding-agent/src/modes/interactive/components/tool-execution.ts), and private [message/tool pairing orchestration](../../.repos/pi/packages/coding-agent/src/modes/interactive/interactive-mode.ts).

Use **Root Agent**, **Child Agent**, **Subagent Access**, **Coordinator Tool**, **Launch Contract**, **Runtime Profile**, and **Recent Activity** as defined by the package context.

## Command contract

Register `/subagents` with strict parsing and argument completion for these forms only:

```text
/subagents
/subagents status

/subagents enable
/subagents disable
/subagents reset

/subagents enable --global
/subagents disable --global
/subagents reset --global

/subagents enable --project
/subagents disable --project
/subagents reset --project
```

Behavior:

- Bare `/subagents` is identical to `/subagents status`.
- `enable` and `disable` without a scope append an explicit override to the selected Root Agent branch and activate or deactivate all six Coordinator Tools.
- `reset` without a scope appends an inheritance marker and immediately follows effective project/global settings.
- `enable|disable --global|--project` writes the selected setting first, then appends the matching current-branch override and applies it to the current session.
- `reset --global|--project` removes that scope's `enabled` key, appends an inheritance marker, re-resolves the remaining setting layers, and applies the result.
- `--global` and `--project` are mutually exclusive and valid only on `enable`, `disable`, or `reset`. Unknown actions, duplicate flags, extra operands, or flags on `status` produce concise usage guidance without changing state.
- A project mutation requires `context.isProjectTrusted()`. Refuse it before opening or changing the project settings file.
- Await `context.waitForIdle()` before changing Root Agent active tools. Child Agent work may remain active.
- Report success with the resulting Subagent Access and scope. Expected parse, trust, settings, or session failures produce actionable notifications rather than uncaught command errors.

Persistent setting success and current-session success are two effects. Write settings first so a persistence failure leaves the current session unchanged. If the settings write succeeds but appending or applying branch state unexpectedly fails, report that the default changed while the current session did not; do not attempt a racy settings rollback.

## Subagent Access contract

`minimalSubagents.enabled` is an optional boolean in both standard settings files:

```json
{
  "minimalSubagents": {
    "enabled": true
  }
}
```

Resolve the effective state in this order:

1. latest valid selected-branch override;
2. trusted project `minimalSubagents.enabled`;
3. global `minimalSubagents.enabled`;
4. built-in default `true`.

Persist branch state as a versioned custom entry owned by a schema. Its representation must distinguish `enabled`, `disabled`, and `inherit`; replay only the latest valid record on `SessionManager.getBranch()`. A missing record is equivalent to `inherit`. Invalid records produce a bounded warning and do not block Registry restoration.

All six Root Agent definitions remain registered in every state. Apply access only after registration:

- **Enabled:** union all six `COORDINATOR_TOOL_NAMES` into `pi.getActiveTools()` once.
- **Disabled:** remove all six names while preserving every unrelated active tool and its order.

Subagent Access is desired branch state. Inspect actual active names separately. When one to five Coordinator Tools are active, status reports the inconsistency as `N/6 active`; status never repairs it. A later `enable` or `disable` reconciles all six.

Lifecycle behavior:

- reload and resume replay the selected branch override;
- tree navigation replays the newly selected branch after successful coordinator restoration;
- forks inherit entries copied from the selected source branch;
- a new session with no override follows settings;
- lowering access never cancels, pauses, disposes, or changes an existing Child Agent;
- Child Agents retain Coordinator Tools granted by their immutable Launch Contracts, including permitted fanout; and
- automatic Coordination Message and terminal-result delivery continues while Root Agent Coordinator Tools are inactive.

Do not add Subagent Access to Registry V2, Fork Snapshot, Launch Contract, Child Agent persistence, or model-visible tool results.

## Settings persistence contract

Pi exposes `SettingsManager` for reading custom fields but no supported generic custom-field setter. Add one package-private settings writer with a narrow operation: set or remove `minimalSubagents.enabled` in a selected scope.

The writer must:

- derive the global path from `getAgentDir()` and the project path from `context.cwd` plus Pi's exported `CONFIG_DIR_NAME`;
- acquire `proper-lockfile` on the target path to serialize same- and cross-process calls and interoperate with Pi's writer;
- create the parent directory when absent;
- re-read bytes while holding the lock;
- strip a UTF-8 BOM, parse JSON, and require an object root plus an object-or-absent `minimalSubagents` value;
- merge or delete only `minimalSubagents.enabled`, preserving every unrelated field read under the lock;
- remove an empty `minimalSubagents` object after `reset`;
- write a same-directory temporary file, preserve an existing file's mode or use `0o600` for a new file, rename atomically, and clean up the temporary file on failure; and
- release the lock on every path.

Malformed JSON or incompatible shapes are expected settings failures. Keep the original file byte-for-byte unchanged and name its scope/path in the error. Add `proper-lockfile` as a direct runtime dependency and its type package as a development dependency; relying on Pi's transitive installation is not a package contract.

Do not call `context.reload()`: scoped commands update the current session directly, while future sessions read the persisted setting normally.

## Live status contract

In TUI mode, `/subagents status` opens one read-only custom view; it does not append a persistent transcript entry. The view shows:

- effective Subagent Access and whether it comes from a branch override, project, global, or the built-in default;
- authored global and trusted-project values, with unset/inherited states explicit;
- actual Coordinator Tool activation, including partial `N/6` drift;
- running and idle direct-Child counts; and
- the complete Child Agent hierarchy with status, Runtime Profile, elapsed time, and task.

Rows begin collapsed. Up/down selects a Child Agent, Enter expands or collapses its Recent Activity, Pi's configured tool-expansion key toggles tool detail, page keys scroll, and Escape closes the view. Refresh once per second while open, retaining selection, scroll position, expanded agent IDs, and tool-output expansion. Stop the timer and settle the `ctx.ui.custom()` promise on close, error, or session shutdown.

Fetch detailed activity only for expanded rows. The current `RecentAgentActivity[]` projection is insufficient for transcript rendering because it discards message roles and tool-call/result identity. Add an internal, process-local transcript snapshot that:

- clones a bounded recent tail of raw `AgentMessage` values, including the current streaming assistant message;
- preserves tool-call IDs and matching tool results across the tail boundary;
- omits image data, matching the Recent Activity contract;
- exposes the active Child Agent session's real `ToolDefinition` for each visible tool name when available; and
- falls back to existing status/latest-result text when a Child Agent runtime is unavailable.

Render that snapshot with Pi's exported `UserMessageComponent`, `AssistantMessageComponent`, `ToolExecutionComponent`, `CustomMessageComponent`, `BashExecutionComponent`, and summary components. Mirror only the required read-only pairing loop from `InteractiveMode`: assistant messages create separate tool components, matching `toolResult.toolCallId` updates them, incomplete calls remain pending, and streaming assistant content replaces its previous copy on refresh. Pass `showImages: false`. Known Minimal Subagents custom messages use their existing renderers; unknown custom messages use Pi's generic custom-message presentation.

Pi does not export its complete transcript controller. Keep the local adapter limited to recent-message ordering, tool pairing, collapse state, and scrolling. Do not copy editor history, cache-miss notices, parent transcript search, session reconstruction, or other `InteractiveMode` behavior.

Outside TUI mode, skip `ctx.ui.custom()`. RPC mode receives one concise notification with access, source, tool activation, and direct-child counts. JSON and print modes receive no observer-only console output because that would corrupt structured output.

## Intended module changes

| File                                                                     | Responsibility                                                                                                          |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `src/minimal-subagents-config.ts`                                        | Parse boolean `enabled`; return effective value, source, and authored scope values beside existing roles/depth          |
| `src/minimal-subagents-access.ts`                                        | Own the versioned branch record, settings/branch resolution, six-tool reconciliation, and partial-activation inspection |
| `src/minimal-subagents-settings-writer.ts`                               | Coordinate merge-preserving global/project settings mutations with lock and atomic replacement                          |
| `src/minimal-subagents-command.ts`                                       | Parse the finite command grammar, complete arguments, execute scoped actions, and format text outcomes                  |
| `src/minimal-subagents-status-panel.ts`                                  | Build the live hierarchy view and render bounded Child Agent transcript snapshots with Pi components                    |
| `src/minimal-subagents-context.ts`                                       | Select the bounded, image-free raw activity tail while preserving tool/result pairing                                   |
| `src/minimal-subagents-types.ts` and `src/minimal-subagents-sessions.ts` | Expose only the process-local transcript snapshot and Child Agent tool-definition lookup required by the status panel   |
| `src/minimal-subagents-coordinator.ts`                                   | Provide lazy trusted-UI transcript inspection without changing model-visible `subagent_status`                          |
| `src/minimal-subagents-extension.ts`                                     | Register `/subagents`, compose the writer/access/status modules, and apply access during start/tree/shutdown            |
| focused package tests                                                    | Cover parsing, persistence, lifecycle, non-destructive disablement, transcript pairing, refresh, and cleanup            |
| `package.json` and `pnpm-lock.yaml`                                      | Declare settings-lock dependencies                                                                                      |
| `CONTEXT.md`, `README.md`, and `skills/pi-minimal-subagents/SKILL.md`    | Keep canonical language, document commands/settings, and route diagnosis through `/subagents status`                    |
| `.changeset/*.md`                                                        | Minor release note for the new command, settings, and live status view                                                  |

Keep the existing compact activity widget in `minimal-subagents-ui.ts`; the command view is a separate owner with a separate lifetime. Add no generic command framework, UI toolkit, event bus, Registry version, settings abstraction with hypothetical implementations, or status transcript persistence.

## Implementation sequence

### 1. Characterize current lifecycle, tools, and delivery

Record the baseline:

```bash
git status --short
git rev-parse HEAD
pnpm --filter @ian-pascoe/pi-minimal-subagents typecheck
pnpm --filter @ian-pascoe/pi-minimal-subagents test
```

Extend the existing lifecycle harness before changing behavior. Characterize that startup currently registers all six Root Agent Coordinator Tools, active Child Agent work survives unrelated Root Agent active-tool changes, and automatic result delivery does not depend on those tools remaining active. Preserve the existing model-visible `subagent_status.recent_activity` shape and bounds.

**Complete when:** focused tests pin all six names, unrelated active tools, active-child continuation, delivery, current `AgentDetail`, and the package baseline is green.

### 2. Build Subagent Access as a pure state boundary

Add config tests first for global/project/default precedence, authored scope reporting, invalid booleans, untrusted-project omission, and compatibility with existing roles/depth behavior.

Create the versioned branch-entry schema and pure replay/resolution operations. Cover absent, enabled, disabled, inherit, multiple records, sibling branches, malformed records, and bounded diagnostics. Add pure active-tool reconciliation and inspection. Use a small `fast-check` property proving enable/disable is idempotent, preserves every non-coordinator name and order, and produces exactly six or zero Coordinator Tool names.

Do not alter Registry replay or Registry checkpoints.

**Complete when:** one typed access snapshot contains effective state, source, authored scope values, and actual tool count; every precedence/branch transition is deterministic; malformed state degrades locally; and pure tests pass.

### 3. Persist scoped defaults safely

Add real-filesystem tests around a temporary agent directory and project:

- create missing global and project settings files;
- set true/false and remove only `minimalSubagents.enabled`;
- preserve unrelated top-level and `minimalSubagents` fields;
- preserve existing mode and use `0o600` for a new file;
- reject malformed JSON, array roots, and non-object `minimalSubagents` without changing bytes;
- reject an untrusted project before I/O;
- serialize concurrent writes through `proper-lockfile` and coordinate with another lock holder;
- clean temporary files after a forced write/rename failure; and
- re-read under lock so an unrelated concurrent edit survives.

Implement the narrow writer only after those tests are red. Add direct dependency declarations and update the lockfile.

**Complete when:** the writer changes one nested field transactionally, interoperates with Pi's lock, reports typed scope/path failures, leaves invalid files untouched, and all focused filesystem tests pass.

### 4. Register commands and wire lifecycle restoration

Test the command parser and completion table independently, including every accepted form and every rejected flag/operand combination. Register `/subagents` in `MinimalSubagentsLifecycleController.register()` so it exists before session startup without opening files or resources.

During `startSession()`:

1. resolve config and the selected-branch access record;
2. construct and restore the coordinator as today;
3. register every Root Agent tool definition;
4. replace unconditional activation with access reconciliation; and
5. retain the active access/settings owner for commands and status.

During `session_tree`, restore the coordinator and checkpoint first, then replay and apply the selected branch's Subagent Access. On shutdown, close any status view before disposing the existing widget/coordinator. Let copied custom entries supply reload, resume, and fork behavior.

Exercise commands through the real registered-command handler in the ExtensionRunner harness. Cover session enable/disable/reset, global/project mutations, project trust refusal, settings-write failure, persistence-before-activation, branch switching, fresh/reloaded/resumed/forked sessions, partial-tool drift, and command invocation before an active lifecycle exists. Spawn a fanout-capable Child Agent, disable Root Agent access, and prove its current turn, delivery, Launch Contract, and nested capabilities remain unchanged.

**Complete when:** strict commands produce the agreed state in files, selected branch, and active tools; all six definitions remain registered; lifecycle transitions restore the right override; and disabling is demonstrably non-destructive.

### 5. Render live status with Pi transcript components

First add a pure selector for the bounded raw transcript tail. Test user/assistant/thinking/custom/summary/bash roles, current streaming content, tool call/result pairs at the cutoff, orphan historical results, and image omission. Keep the existing flattened `RecentAgentActivity[]` used by model tools unchanged.

Add a process-local Child Agent transcript snapshot and lazy coordinator inspection for expanded rows. Return copied messages plus only the tool definitions needed by the snapshot; persist neither. Test available, running, idle, unavailable, deleted, and runtime-replacement cases.

Build the status view test-first with a plain theme and fake timers. Cover:

- access/source/scope/tool-count header states;
- direct-child counts plus complete nested hierarchy;
- deterministic row order and narrow-width truncation;
- selection, scrolling, row expansion, and tool-output expansion;
- assistant text/thinking and user rendering through Pi components;
- pending, successful, failed, and custom-rendered tool calls paired by stable ID;
- streaming refresh without duplicate transcript blocks;
- lazy activity reads only for expanded rows;
- preserved interaction state across one-second refreshes;
- Escape, error, command completion, and session shutdown clearing every timer/component; and
- RPC notification fallback with JSON/print silence.

Use the child runtime's actual tool definitions where available; let `ToolExecutionComponent` supply its built-in or generic fallback otherwise. Append no custom status entry to the Root Agent transcript.

**Complete when:** the live view looks like Pi's normal transcript for every supported activity role, remains bounded and image-free, updates in place, and leaves no timer or UI ownership after closing.

### 6. Document, release, and verify

Update the README with:

- `minimalSubagents.enabled`, default and project-over-global precedence;
- the complete command grammar and reset semantics;
- Root-Agent-only, non-destructive disablement;
- reload/resume/tree/fork behavior;
- partial activation diagnostics;
- live transcript-style status controls and non-TUI behavior; and
- trusted-project and malformed-settings failures.

Retain the implementation-free `Subagent Access` glossary definition already added to `CONTEXT.md`; no ADR is warranted. Update the package skill's context pointer and steps so Subagent Access or missing Coordinator Tools lead first to `/subagents status`, while existing spawn/delivery/recovery diagnosis remains behind the same skill. Add a minor Changeset; do not edit the package version directly.

Run focused checks after each slice, then:

```bash
pnpm format
pnpm --filter @ian-pascoe/pi-minimal-subagents typecheck
pnpm --filter @ian-pascoe/pi-minimal-subagents test
pnpm pack:check
pnpm verify
pnpm changeset:status
git diff --check
git status --short
```

Smoke-test the source-loaded package in a real Pi TUI:

1. start without configuration and confirm all six tools plus built-in `true` status;
2. start with global `false`, then session-enable and reset;
3. set conflicting global/project values and confirm source reporting and project precedence;
4. use each scoped enable/disable/reset form and inspect both settings files;
5. switch branches, reload, resume, and fork to confirm branch inheritance;
6. run a Child Agent, open status, expand its live transcript through text, thinking, tool work, and completion;
7. disable while that Child Agent runs and confirm continued fanout-per-contract and result delivery; and
8. close/reopen status and quit/reload while open, confirming no stale panel, widget, timer, or command state.

**Complete when:** every automated check and smoke step passes, the packed package contains all new source and skill files plus declared dependencies, and no Registry, Delivery Ledger, Launch Contract, Child Agent capability, or model-visible result changed.

## Acceptance checklist

- [ ] `/subagents` and `/subagents status` open the same live read-only status view.
- [ ] Every accepted command form completes; every other form returns usage without mutation.
- [ ] Global/project/default/session precedence and reset inheritance are correct and branch-scoped.
- [ ] Scoped settings writes are trust-checked, lock-coordinated, merge-preserving, mode-safe, and atomic.
- [ ] A persistence failure leaves current Subagent Access unchanged; a later session reads successful writes.
- [ ] All six Root Agent definitions remain registered; enabled activates six, disabled activates zero, and unrelated tools are unchanged.
- [ ] Partial external activation is reported as `N/6` and status remains read-only.
- [ ] Existing Child Agents, Launch Contracts, fanout capability, Coordination Messages, and terminal delivery survive disablement.
- [ ] Reload, resume, tree navigation, fork, and new-session behavior match the lifecycle contract.
- [ ] Status shows effective/source/scope values, direct counts, and the complete hierarchy.
- [ ] Expanded Recent Activity uses Pi transcript components with stable tool pairing and actual Child Agent renderers when available.
- [ ] Activity is bounded, image-free, lazy, live, scrollable, and collapsed by default.
- [ ] TUI close/error/shutdown paths release every timer and UI handle; RPC fallback is concise and JSON/print stay silent.
- [ ] Existing widget, `subagent_status`, Registry V2, Delivery Ledger, and model-visible content retain their contracts.
- [ ] README, skill, glossary, Changeset, package manifest, and shipped behavior agree.
- [ ] Package checks, `pnpm verify`, pack check, and the real TUI smoke test pass.

## Approval

Implementation was explicitly approved after this plan was reviewed.
