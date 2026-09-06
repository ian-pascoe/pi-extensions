# Lightweight Pi context management

**Package:** `@ian-pascoe/pi-context-management`

**Status:** production package implemented on 2026-09-06 after the accepted native-checkpoint prototype. The three tools, two commands, budget safeguards, native compaction takeover, and capability-guarded adapter are implemented with SDK regression tests. Runtime capabilities—not an exact Pi version—control activation; Pi 0.85.1 remains the pinned development baseline. Storage failures quarantine the loaded journal and require reopening the persisted session—not merely resource `/reload`; transactional repair is deliberately not implemented. See the [package README](../../packages/pi-context-management/README.md) and historical [prototype verdict](../../packages/pi-context-management/prototype/README.md).

- [Glossary](../../packages/pi-context-management/CONTEXT.md)
- [ADR-0001: native compaction checkpoints](../../packages/pi-context-management/docs/adr/0001-use-native-compaction-checkpoints.md)
- [Codex research and comparison](../research/2026-09-05_codex-context-manipulation.md)

## Implementation verification — 2026-09-06

- Full repository suite: 812 tests passed; review added four regressions, bringing the package suite to 43 and the repository total to 816. Root and all 14 package typechecks passed; changed code passed lint and formatting checks.
- Standards review: clarified persisted-session reopening versus `/reload` and removed an unused adapter callback.
- Spec review: fixed request quarantine across resource reload, source-and-entry provenance checks, and preservation of an acknowledged native checkpoint after live-state refresh failure.
- Clean npm Git-install check passed for all 13 extensions/skills; the new package's 11 published files were checked. The full tarball-install matrix exceeded its 240-second limit and is not claimed verified.
- Integration evidence uses real Todo, CodeMode/Deno, native session builders and journals; MCP remains contract fixtures, and no live-provider Child Agent delivery was exercised.

## Goal and scope

Continue a Pi session across Context Windows using agent-written Notes, retrievable original History, and native Context Checkpoints. Preserve the working environment and existing running tools/Child Agents rather than starting a replacement session.

No background model workers, separate summarization calls, embeddings, database, daemon, repository memory files, dashboard, replacement subagent framework, or CodeMode exposure management. Direct session-file editing is excluded.

## Interface

| Surface            | Responsibility                                                                                                                |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `context_notes`    | Maintain independently named Markdown Notes and retrieve their contents.                                                      |
| `context_history`  | Browse Context Windows and their items, perform literal search, and read original recorded content through stable references. |
| `context_rollover` | Supply an agent-written Handoff and request an immediate Rollover at a safe commit point.                                     |
| `/context`         | Read-only inspection of budget, Notes, and recent Context Windows.                                                            |
| `/rollover`        | Ask the agent to checkpoint and request Rollover.                                                                             |

Keep operations grouped under these three tools rather than registering a tool for each operation. Lists and reads must be bounded and paginated/ranged; do not turn retrieval into another unbounded context injection. Names are session-local Note identifiers, not filesystem paths.

Users configure CodeMode exposure themselves. Do not modify their routing or make a particular exposure rule an activation prerequisite. Regardless of routing, a tool must not commit a Rollover across an unsafe or incomplete tool batch.

## Notes and History

- Notes belong to the active Pi session branch. Resume restores them; forks inherit the selected history and then diverge; a new independent session starts empty.
- Notes have no required taxonomy. The main agent chooses what to write and update; Notes are not automatically extracted by another model.
- Persist each successful Note change independently. A later failed/cancelled Rollover does not revoke an acknowledged Note write.
- History retrieval covers the active branch, including earlier Context Windows and inherited fork history. Exclude abandoned sibling branches and unrelated sessions.
- History is read-only. Rollover does not delete the original transcript.
- Recover only content actually recorded and still available. Report missing external spills or unsupported content explicitly; do not invent the original output.
- Cross-agent shared mutable Notes and a project-wide memory store are out of scope. Inheriting a context snapshot must not be confused with receiving unrestricted access to its source session's Notes and History.

## Fresh Context Window

Carry forward:

1. Standing instructions and current required environment/tool context.
2. The agent-written Handoff.
3. A compact Note Index; full Notes are read on demand.
4. A bounded Tail and stable History references for omitted oversized groups.
5. Subsequent conversation and current live context contributions from other extensions.

The Tail allowance defaults to **16k tokens** and is configurable. It is a maximum, not a guaranteed allocation. Preserve complete tool-call/result groups. Omit an oversized group with a short retrieval reference rather than splitting its protocol structure or exceeding the allowance; this is not a generated summary.

Preserve standing instructions and the Handoff first, bound the Note Index, and shrink the effective Tail when necessary. Never silently truncate the Handoff. If essential fresh context cannot fit, stop with an actionable error.

## Rollover and recovery

### Normal Rollover

The main agent decides when to request Rollover, prompted by budget reminders. It updates its Notes and supplies a Handoff. Commit a native Context Checkpoint before switching the active context, then continue the task without replaying completed tools or resetting the environment.

A safe commit point must account for the entire tool batch, not just the Rollover handler returning. The first implementation should reject unsafe placement before mutation rather than attempt speculative concurrency support.

### Automatic safeguards

Both thresholds are configurable and use the **usable input budget after reserving model-output space**, not the whole advertised context window:

- **80%:** warn the agent to update Notes and prepare its Handoff.
- **90%:** perform Emergency Rollover if normal Rollover has not occurred.

Emergency Rollover uses the last saved Notes/Handoff, the effective Tail, and History references. Visibly report it, label the Handoff as potentially stale or absent, and instruct the agent to recover recent History before continuing. Do not manufacture a summary or discard History.

If a provider rejects an oversized request before preflight catches it, allow **one** emergency rebuild-and-retry. Do not replay completed tool calls. If the rebuilt request still overflows, stop. Deliberate user cancellation must never trigger automatic recovery.

Coordinate this one-attempt policy with Pi's native overflow recovery; do not stack an extension retry loop on top of Pi's retry.

### Native compaction ownership

Take over native manual, threshold, and overflow compaction through `session_before_compact`, supplying the extension-owned checkpoint and retained Tail instead of Pi's LLM summary. Successful native compaction should remain successful—not routine cancellation with warning spam.

Users must not have to remember to disable auto-compaction, and the extension must not silently rewrite global settings. Native `/compact` retains Pi's normal interruption behavior: Pi aborts the active run before invoking the hook. `/rollover` remains the deliberate agent-led request path.

Another compaction owner must not silently replace this policy. Inspect actual hook results during native dispatch, not listener counts: allow passive observers and cancellation, but report the source and cancel competing summaries in either load order. Guard the final result against missing ownership or summarizer fallback. Fail closed on known conflicts or preparation failures. A thrown hook can let Pi fall back to its native summarizer, so expected errors require explicit handling rather than an uncaught exception.

## One checkpoint representation

Every Rollover must produce a native Pi `CompactionEntry` understood by the parent, native session context construction, resume, forks, and existing Subagent inheritance. Do not introduce a second virtual-only checkpoint representation and then modify its consumers to compensate.

Native compaction hooks cover native lifecycle paths. Arbitrary-time Rollover requires a **narrow, runtime-capability-checked adapter** beyond the extension-facing read-only session interface. This trade-off is accepted; deferred-only compaction is not the substitute design.

The adapter must maintain coherent persisted state and the parent's live context. Merely casting to call `appendCompaction` is insufficient. It must also preserve the accepted commit-failure behavior: a failed commit leaves the old Context Window active, while previously successful Note writes remain saved.

Unsupported runtime versions/capabilities must be reported before unsafe mutation. Do not silently weaken Rollover semantics, use nonexistent retained-entry IDs, or edit the session file directly.

## Visibility and coexistence

- Show a concise notice for normal and emergency Rollovers.
- `/context` reports configured/effective Tail, context-budget information, Notes, and recent windows. Distinguish measured usage from estimates, especially around transitions.
- No custom Note editor initially; users ask the agent to edit Notes.
- Preserve current Todo projections, MCP prompt replay/system instructions, and other supported live context contributions. Rebuilding outgoing messages only from persisted entries can lose these additions.
- Existing Child Agents and CodeMode bindings must survive. Verify ordinary `inherit` against native checkpoints without adding a Minimal Subagents-specific integration.
- Validate inherited reference provenance: context inheritance is not automatically a copy of the source session's Note store or archive. Do not advertise unavailable parent-session references as child-local resources.
- `/context` and `/rollover` do not collide with Pi 0.85.1 built-ins or current repository commands; other installed context-manager packages may conflict.

## Adapter proof gate

The confirmed first step has been executed without package scaffolding, dependency changes, or real model calls. The candidate commits at awaited `turn_end`, synchronizes native/live messages, and refreshes the active loop through `prepareNextTurnWithContext` before normal preflight/context hooks. It does not require a virtual-only checkpoint format or a Subagent integration.

The [prototype verdict](../../packages/pi-context-management/prototype/README.md) distinguishes passing characterization checks from production readiness. A real `EACCES` leaves speculative in-memory journal entries absent from disk and can prevent persistence of Pi's own abort response. The candidate preserves the old checkpoint and stops further model calls, but cannot claim transactional rollback. Strict gate mode reproduces the failure. Record the fail-closed/reload limitation in production work rather than silently claiming transactional rollback. Per the user's direction, stop expanding the prototype; the remaining obligations below are not claimed verified.

The complete gate must prove:

1. **Native takeover:** manual, threshold, and overflow compaction commit our checkpoint with no summarizer call or cancellation spam. Native overflow recovery and the one-attempt limit remain coordinated.
2. **Immediate commit:** early/small-session and mid-tool-loop Rollover create a real native checkpoint at a safe point and continue correctly. Test an empty effective Tail as well as normal and oversized tool groups.
3. **One coherent view:** the parent request, native `buildSessionContext`, default child inheritance, resume, fork, and tree navigation agree on the checkpoint boundary. Old failed responses and discarded transcript do not reappear after reload.
4. **Durability:** injected append/write failure, cancellation before/after the commit point, and interruption around continuation do not leave an acknowledged success with inconsistent live/persisted state. Pi currently mutates in-memory session state before writing; do not assume append is transactional.
5. **Budget safety:** reserve model-output space, bound the fresh prompt, shrink the effective Tail as required, and prevent repeated empty/emergency Rollovers. Test missing/oversized Handoffs and large static instructions/tool declarations.
6. **Coexistence:** preserve Todo/MCP additions under both hook orders, existing Child Agent delivery, and CodeMode process state. Ensure unsafe nested/non-isolated Rollover cannot mutate state even though exposure is user-controlled.

Runtime method selection, output-reserve derivation, token-estimation margin, inherited-reference handling, and empty-Tail checkpoint construction are proof obligations, not already-verified implementation details. If the prototype cannot satisfy them, report the concrete failure and reopen the design rather than quietly shipping a shadow checkpoint or deferred-only behavior.

Production implementation now includes Notes/History, budgets/native takeover, both commands and notices, and the prototype regressions at SDK/tool seams. It also tests real Todo projection and CodeMode Deno binding survival, nested rollover refusal with independently durable Notes, and MCP-style hook contracts in both orders. Context inheritance is checked through the native builder and forked journals; this does not claim a live-provider Child Agent delivery test. Output estimates are conservative rather than exact provider tokenization. An oversized initial request must be shortened before the first assistant response because Pi defers journal persistence until then. No storage or orchestration service was added.

## Decision record

All interview decisions are accepted: Q1–Q9 define scope, Tail, retrieval and visibility; Q10–Q13 define emergency behavior, thresholds and budget priorities; Q14 takes over native compaction; Q15 leaves CodeMode exposure to the user; Q16 requires durable independent Notes and safe checkpoint commits; Q17 selects the package/tools/commands; Q18 accepts the guarded native-checkpoint adapter and withdraws the proposed Subagent integration.

Rejected alternatives: loading all Notes into every window; a zero-Tail default; background summarization/embeddings; requiring users to disable native compaction; CodeMode exposure management; virtual-only checkpoints plus consumer-specific integrations; deferred-only Rollover; direct session-file edits.

## Source evidence and validation limits

The earlier research inspected reference source and upstream tests; an upstream test attempt could not execute because the reference checkout lacked `partial-json`. The new prototype instead imports the existing installed Pi 0.85.1 compiled SDK explicitly and runs with scratch journals and a fake stream. The checkout currently resolves Pi 0.85.0, which the runner rejects as an untested target. Exact runtime paths, file hashes, commands, results, and uncovered cases are recorded in the [prototype README](../../packages/pi-context-management/prototype/README.md).

- Native custom-compaction success path: `.repos/pi/packages/coding-agent/src/core/agent-session.ts:1974–2069,2273–2405`; existing tests `test/suite/agent-session-compaction.test.ts:110–165,394–530` and `test/suite/regressions/5217-compaction-reason.test.ts`. Native preparation/authorization can fail before the hook; another compaction handler can override its result.
- Extension mutation limitation: `session-manager.ts:190–207` excludes `appendCompaction` from `ReadonlySessionManager`; `extensions/runner.ts:723–747` passes the live manager. Native compaction rebuilds live messages; a direct append alone does not.
- Existing inheritance: `packages/pi-minimal-subagents/src/minimal-subagents-extension.ts:131–134` uses native `buildSessionContext`; upstream `session-manager.ts:414–452` applies the latest compaction and retained history.
- Usage: upstream `agent-session.ts:3383–3424` and `compaction/compaction.ts:202–239` use the latest provider measurement plus estimated trailing messages. Transition gaps can be stale; a successful new-window response normally restores a useful measurement. System/tool overhead still needs accounting.
- Tool composition: `packages/pi-codemode/src/pi-tool-bridge.ts:310–329,465–506` and `codemode-tool-contract.ts:533–547` return inner results to the Cell, not independent persisted tool results. Captured `pi.appendEntry()` reaches the live session manager, but nested persistence/cancellation still needs testing.
- Live projections: `packages/pi-todo/src/pi-todo-extension.ts:115–142`; `packages/pi-mcp/src/pi-mcp-extension.ts:312–318,698–700,1024–1062`; upstream `extensions/runner.ts:1034–1064,1131–1194` chains context/system-prompt handlers.
- Command dispatch: upstream `interactive-mode.ts:3068–3072,6563–6568` handles native `/compact` before extension command/input hooks.
- Configuration precedent: `packages/pi-formatter/src/pi-formatter-extension.ts:327–330` uses exported `SettingsManager` with global and trusted-project layers. Tail allowance is separate from Pi's native response reserve.
