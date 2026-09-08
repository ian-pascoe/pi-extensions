# Subagents overlay viewer

**Status:** Implementation authorized and completed. See [verification and limitations](subagents-overlay-viewer-verification.md).

## Outcome and boundaries

Replace the editor-hosted `/subagents` view with a focused, centered overlay for browsing the Child Agent tree and inspecting a full live Child Session Transcript. Add double-Left access and tree-preserving active-first ordering in both the viewer and compact widget.

Use the vocabulary in [Minimal Subagents context](../../packages/pi-minimal-subagents/CONTEXT.md). The interview added **Active Child Agent** and **Child Session Transcript** there; implementation behavior belongs in this plan and the package README, not the glossary.

Keep these boundaries throughout:

- Inspection is read-only. Opening, scrolling, or closing the viewer leaves Root Agent input, Child Agent work, Subagent Access, and delivery state intact. Message, cancel, and delete controls are outside scope.
- `/subagents` and `/subagents status` reach the same viewer. Access-changing subcommands retain their behavior. RPC retains its status notification; JSON and print modes remain silent for observer-only output.
- Full history belongs only to the trusted UI transcript path. Model-facing `recent_activity`, status tools, and Wait Events retain their existing bounds and contracts.
- Preserve selected-branch ownership and leaf verification from [the branch lifecycle ADR](../../packages/pi-minimal-subagents/docs/adr/0002-branch-scoped-registry-and-child-session-position.md). No Registry migration, persistence rewrite, new dependency, or configurable key-sequence framework is required.

## Implementation sequence

### 1. Order presentation trees by subtree activity

Start in [the status panel](../../packages/pi-minimal-subagents/src/minimal-subagents-status-panel.ts) (`flattenStatusAgents`) and [the widget](../../packages/pi-minimal-subagents/src/minimal-subagents-ui.ts) (`flattenAgentHierarchy`, `buildMinimalSubagentsWidgetView`). Both currently flatten insertion-order trees; the widget chooses active candidates first but emits rows in the original flattened order.

Use one shared presentation-ordering helper for both surfaces, colocated with existing shared rendering logic where practical:

- A subtree is active when its own agent or any descendant is an Active Child Agent. Use running-turn state, not availability labels, latest terminal results, or runtime existence.
- At every sibling level, place active subtrees before wholly inactive subtrees. Preserve existing sibling order within each priority group; the earlier newest-first proposal was rejected.
- Emit each parent before its descendants, retaining indentation and canonical IDs. An idle parent moves with its active descendant rather than separating the descendant from its tree.
- Compute activity on the complete hierarchy before widget filtering. Preserve the widget's ancestor inclusion, candidate policy, row limits, overflow reporting, and cooldown.
- Order presentation copies rather than mutating coordinator or persisted hierarchy order. Keep viewer selection attached to agent identity when priorities change.

**Done when:** `status-panel.test.ts` and `ui.test.ts` demonstrate the same ordering for active roots, idle parents with active descendants, nested siblings, and stable ties. A running child stays beneath its parent, active-containing branches precede wholly idle branches, widget ancestors survive row limiting, and refresh does not switch the selected agent.

### 2. Provide the full selected-branch transcript

Trace the UI-only path through [`inspectTranscript`](../../packages/pi-minimal-subagents/src/minimal-subagents-coordinator.ts), [`ChildAgentTranscriptSnapshot` and the runtime/factory seams](../../packages/pi-minimal-subagents/src/minimal-subagents-types.ts), and [session snapshots and identity verification](../../packages/pi-minimal-subagents/src/minimal-subagents-sessions.ts). The current `snapshotActivityTranscript()` feeds post-compaction `session.messages` into the bounded selector in [the context module](../../packages/pi-minimal-subagents/src/minimal-subagents-context.ts). Removing its message-count limit alone would still omit pre-compaction history.

Extend the existing UI transcript path rather than creating a second session store:

- Read conversation history along the child's selected native SessionManager branch. Include inherited parent context, earlier turns, and messages predating compaction; preserve current streaming output alongside committed history.
- Convert conversation entries and user-visible summaries to the existing transcript message representation. Honor custom-message visibility. Exclude abandoned branches and internal Registry, identity, ownership, and delivery-bookkeeping entries.
- A live runtime supplies its current selected branch and streaming message. Merge committed and streaming output exactly once as messages finish; do not append a duplicate of a newly persisted assistant message.
- For a child without a runtime, use the existing session-factory boundary for history-only access. Reuse `verifyChildSessionIdentity` and read the recorded Child Session Position explicitly. A missing or unverifiable position produces an explanatory unavailable state, never a guessed file-head transcript.
- Inspecting saved history must work independently of model/tool restoration dependencies: it must not call `openRuntime`, start model work, append records, or move the selected leaf. Missing or mismatched files produce a visible error/fallback without displaying unverified content.
- Update snapshot naming/comments as needed to distinguish full UI history from bounded Recent Activity. Keep the latter's limits and image-exclusion behavior unchanged.

Reuse `renderTranscriptSnapshot` and Pi's transcript components. Preserve chronological tool-call/result pairing and real tool definitions when available; historical tools without loaded definitions use generic rendering. Reasoning remains visible. Tool output starts collapsed and uses Pi's configured tool-expansion key. Replace image content with explicit text placeholders, including image-only messages, rather than silently dropping it; inline image rendering is outside scope.

Load history for the inspected child, not every row in the tree. Preserve access to all older messages while avoiding repeated full-file loading and reconstruction on every refresh; reuse native components and existing invalidation mechanisms before adding caching infrastructure.

**Done when:** focused cases in `sessions.test.ts`, `coordinator.test.ts`, `context.test.ts`, and `status-panel.test.ts` prove:

- History exceeding the old tail limit includes inherited context and pre-compaction messages, while sibling-branch messages and bookkeeping stay absent.
- Streaming text transitions to committed history without duplication; tool calls/results remain paired across old cutoff and turn boundaries.
- Valid saved history remains inspectable without a runtime; invalid ownership, missing files, or missing positions never fall back to another leaf or initiate model work.
- Image-only content has a placeholder, reasoning renders, and collapsed tool output can be expanded.
- Model-facing Recent Activity remains bounded and unchanged.

### 3. Turn the status panel into a two-view overlay

Keep ownership in `MinimalSubagentsStatusPanelController` and reuse its single-open promise and disposal lifecycle. Use native `ctx.ui.custom(..., { overlay: true, overlayOptions })`, not editor text or a persistent side pane.

Before changing overlay code, read Pi's current [extension UI documentation](../../.repos/pi/packages/coding-agent/docs/extensions.md), [TUI documentation](../../.repos/pi/packages/coding-agent/docs/tui.md), and the [overlay example](../../.repos/pi/packages/coding-agent/examples/extensions/overlay-test.ts). Verify behavior against the installed/supported Pi API; reference checkouts can differ from the runtime.

Implement two states within one overlay:

- **Tree:** the live hierarchy and existing access/status information. Up/Down selects; Enter opens the selected Child Session Transcript. Escape closes the overlay.
- **Transcript:** the selected child's identity/status and scrollable conversation. Open at the latest output. Escape returns to the tree with its selection retained; the next Escape closes.

Draw a theme-compatible frame and fill the pane: native overlay compositing supplies neither framing nor a background. Use a large centered pane with terminal margins and adapt to resize. Derive body height from the pane's actual inner bounds so its header and help remain visible; the current full-terminal `viewportHeight()` calculation cannot simply be retained beneath an overlay height cap.

In the transcript, Up/Down scroll by line and Page Up/Page Down by page. Follow incoming output while at the bottom. Scrolling away from the bottom pauses following and preserves the reading position as output grows; End returns to the latest output and resumes following. Preserve that behavior through tool expansion, text reflow, and terminal resize.

Keep live refresh active while the overlay has focus and Root/Child Agents continue working. Completion changes status without closing the transcript. An empty hierarchy has a clear empty state; if the inspected agent disappears, return safely to the tree with an explanation. Closing or session disposal releases refresh work exactly once and restores editor focus without clearing or rewriting the user's draft.

**Done when:** `status-panel.test.ts` and `extension.test.ts` cover native overlay options, both Escape transitions, latest-output positioning, paused/resumed following, selection preservation, resize bounds, empty/unavailable states, completion/deletion during inspection, single-open behavior, and disposal. Existing access headers and non-TUI behavior still pass their tests.

### 4. Add editor-local double-Left activation

Wire the shortcut through [the extension lifecycle](../../packages/pi-minimal-subagents/src/minimal-subagents-extension.ts) to the same status-panel controller used by the command.

Two consecutive physical Left Arrow presses within **500 ms** open the viewer only when the main editor is focused and completely empty. Whitespace is not empty. A single Left, a late second Left, and all Left presses in a nonempty draft retain normal behavior. Intervening input resets the pending sequence. The shortcut also works while Root Agent output is streaming; it does not require the agent to be idle.

Pi registers single-key shortcuts, not sequences. Registering `left` consumes ordinary cursor movement, while a global `onTerminalInput` listener sees input intended for dialogs even when the underlying editor is empty. Use the documented editor-local composition route (`getEditorComponent` / `setEditorComponent`, with `CustomEditor` as the default) and forward other input unchanged. Consult [the modal-editor example](../../.repos/pi/packages/coding-agent/examples/extensions/modal-editor.ts) and the custom-editor composition guidance in the extension docs before choosing the wrapper shape.

Preserve any previously configured editor factory and its behavior. Bind once per applicable lifecycle, reset sequence state across session changes, and clean up without removing another extension's later editor replacement. Other dialogs, overlays, and transcript navigation must not trigger the shortcut. Opening an already-open viewer must not stack another instance.

**Done when:** deterministic input tests cover the timing boundary, intervening keys, single presses, nonempty/whitespace drafts, main-editor focus versus dialogs/overlays, existing custom-editor composition, repeated opens, and lifecycle cleanup. A genuine double-Left opens the same viewer as `/subagents`; ordinary editing remains unchanged.

### 5. Verify and document the shipped behavior

Use the existing package tests and the workspace validation scripts declared in `package.json`; discover their current commands rather than introducing a separate test harness. Run focused tests during each step, then the package suite and applicable type, lint, and formatting checks.

Before live TUI verification, load the `terminal-control` skill. In a real PTY, exercise a nested hierarchy with an idle parent and active descendant, a long live transcript, and a draft in the main editor. Verify the framed overlay rather than relying only on mocked `ui.custom` calls:

- Open by command and by double-Left; confirm tree order in both surfaces.
- Inspect a child, scroll into history while output arrives, resume with End, and expand tool output.
- Resize the terminal; verify readable bounds and accessible navigation/help.
- Return to the tree, close, and verify the original editor content/focus and ongoing agent work.
- Check that draft editing and another dialog's Left navigation do not open the viewer.

Update [README: Status and TUI](../../packages/pi-minimal-subagents/README.md) and any package skill guidance that describes the replaced behavior. Document the two-view navigation, shortcut guard, tree ordering, full-history boundary, following behavior, and image placeholders. Keep the glossary definitional; these reversible UI choices do not require an ADR.

**Done when:** the agreed behavior has passing automated coverage and saved PTY evidence, documentation describes the implemented behavior, and the handoff names the checks run and any remaining limitations. Record verification evidence and any supported-runtime changes in the completion report.
