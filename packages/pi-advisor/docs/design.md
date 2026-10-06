# Pi Advisor design

Status: accepted and implemented.

Package: `@ian-pascoe/pi-advisor`.

The [Advisor glossary](../CONTEXT.md) defines the domain terms. This document records the agreed behavior, not a replacement compaction or agent framework.

## Purpose and authority

An Advisor reviews an observed agent's work and offers actionable advice. Default review priorities are instruction violations, scope drift, repeated failures, unsupported completion claims, and worthwhile low-risk cleanup or simplification. It stays silent when there is no useful finding.

The Advisor Prompt is replaceable. Permissions, attribution, delivery rules, and limits remain enforced outside that prompt. Standing instructions and observed conversation content are review evidence, not permission to expand the Advisor's capabilities.

Interventions are user-visible and attributed to the Advisor. Concerns and Blockers use Pi's native steering boundary when permitted; Nits use non-interrupting native context delivery. Interventions do not veto actions, cancel running tools, or override user instructions.

One Advisor watches each participating agent session. Advisors are not ordinary task-performing Child Agents, and must never recursively create Advisors for their own sessions.

## Configuration and controls

All Advisor options support global, trusted-project, and session scopes:

1. Explicit session override.
2. Trusted project setting.
3. Global setting.
4. Package default.

Unset means inherit, not disabled. Prompt overrides replace the whole value rather than concatenate prompts. An explicit `allowedTools` list replaces the inherited list. Global disable is an overridable default, not a master kill switch.

Use native Pi settings files and native session entries, not a separate configuration store. Session overrides follow the selected branch, survive resume, and inherit through forks; abandoned branch state is excluded.

Provide commands for on/off/inherit, scoped configuration, and status. In the interactive TUI, a bare `/advisor` opens a settings menu built from Pi's native settings list and shown in the editor area, as `/settings` is, rather than a bespoke dashboard; prompt editing uses Pi's native editor component. Menu edits apply immediately at the selected scope, and closing the menu records one status entry listing them. Without the TUI, a bare `/advisor` records status. Status shows effective settings and their sources, review state, backlog, usage/cost, the last Review's cost and the running total of Reviews (from the Advisor Session's native usage, including any compaction a Review ran and Reviews that failed after prompting; a Review without usage on a priced model costs $0), each Child Agent's Review cost, findings awaiting re-validation, findings dropped (over the Nit cap, for missing or unknown evidence, and Nits of a superseded re-validating Review), Reviews ended by invalid reports, and the last error. Unknown cost must not be presented as zero. Status entries render as a compact summary that expands to the full settings table; an enabled Advisor also shows its state and backlog in the footer. Rendering is UI-only and never changes model-visible Intervention content.

Changes affect the current watched hierarchy immediately when its effective configuration changes. Other Pi processes pick up persisted global/project changes on startup or reload; there is no cross-process remote-control mechanism.

| Option                         | Default                                      |
| ------------------------------ | -------------------------------------------- |
| Enabled                        | `false` globally                             |
| Watched sessions               | Main only                                    |
| Reviewer instructions          | Supplied default Advisor Prompt; replaceable |
| Advisor model                  | Inherit the observed agent's model           |
| Advisor thinking level         | Inherit the observed agent's thinking level  |
| Allowed tools (`allowedTools`) | `read`, `grep`, `find`, `ls`                 |
| Catch-up threshold             | `3`; any positive integer or `off`           |
| Review Cadence (`reviewEvery`) | `turn`; `request` or any positive integer N  |
| Advisor Session size cap       | `auto` (½ the Advisor window, at most 200k)  |
| Per-review deadline            | 120 seconds; configurable                    |
| Investigative tool-call limit  | 8 per Review; configurable                   |
| Findings per Review            | 4; configurable from 1 through 32            |
| Nits per request               | 3; any non-negative integer                  |
| Automatic Corrective Turns     | 1 per observed request/task; configurable    |

Model and thinking overrides are independent. Do not silently select another provider or model when resolution or inference fails.

## Extension inheritance and tool access

Load the observed/main session's extensions in the Advisor Session, using fresh session-bound factory instances rather than copying parent-bound handlers or tools. Inheriting `pi-advisor` must not recursively create another Advisor. This supersedes the earlier Context-Management-only extension allowlist.

Configure a tool-name allowlist, `allowedTools`, defaulting to `read`, `grep`, `find`, and `ls`. It replaces the separate investigation enable/disable option. Users can add extension tools such as `lsp_diagnostics`, `context_notes`, `context_history`, and `context_rollover`. The Advisor's constrained advice-output mechanism remains intrinsic rather than requiring an entry in this list.

Tool permission and extension loading are distinct: loading an extension does not automatically grant its tools. Sibling extensions are optional; their absence must not make `pi-advisor` a missing-dependency error.

The standard implementations of the default tool names are read-only, but **not a filesystem sandbox**: they may read paths outside the project that Pi's OS account can access. Inherited extensions can replace those implementations. No bespoke confinement layer is requested, and the default list grants no shell-command tool name.

The Advisor is **read-only by default, not by invariant**. An explicit tool-name grant permits that tool's full interface, subject to the tool's native policies; for example, granting `lsp_apply` permits applying Workspace Edit Previews. Do not add per-operation permission filters or silently expand the configured grant through aliases or replacement tool bundles.

Loaded extensions remain privileged code. Their hooks can have effects outside model tool calls; `allowedTools` is not a sandbox for extension behavior.

A grant is Pi's tool ceiling, not a declaration: tools with `codemode` or `deferred` exposure stay callable by scripts but are not declared to the Advisor model unless a granted tool (such as `tool_search`) declares them, matching Minimal Subagents Child Agents. Ignore configured tool names that are unavailable, and report those names in status; status is a point-in-time view, so tools that register after connecting (such as MCP tools) are reported until they register. This permits one configuration across different installed extension sets without hiding misspellings. A loaded extension requiring tools excluded by the grant is a separate compatibility issue, not the same as an absent optional extension.

The Advisor retains its own prompt and session state. Supply the observed agent's standing instructions deliberately as review context rather than transplanting its assembled operating context or private state. Preserve inherited extensions' normal session-local hooks and instructions.

## Advisor Session and optional Context Management

Each Advisor continues to use a private, persisted native Pi session. This storage decision remains in place, but Context Management is no longer a mandatory dependency or an automatically granted tool set.

When Context Management is present among the inherited extensions, users can grant its tools through `allowedTools`:

- `context_notes`
- `context_history`
- `context_rollover`

When granted, these tools operate on the Advisor's own Notes, History, and Context Checkpoints—not those of the observed agent. References copied from the observed conversation do not grant access to the observed session's private store.

Pi owns the agent loop, session journal, compaction policy, context accounting, and retention of recent conversation. Without Context Management, use ordinary native compaction. When loaded, Context Management replaces native summarization with Notes/Handoff preparation and durable native Context Checkpoints. Do not add another compaction policy or bypass its durability guards.

Every Review re-reads the whole Advisor Session, so its size sets the cost of each Review. `maxSessionTokens` (default `auto`: half the Advisor model's context window, Pi's 128k fallback, at most 200k tokens; explicit values capped at the window) adds one trigger and nothing else: after a Review, when Pi's context usage for the Advisor Session (or Pi's per-message estimate when no usage is reported yet) exceeds the larger of the cap and `compaction.keepRecentTokens`, call the session's native `compact()` with instructions to keep the observed request, reported findings, open concerns, and verified facts. Pi chooses the cut point, retention, and summary; there is no custom summarizer or rollover. `auto` leaves room for an `auto` Context Seed plus as much again, so a full seed alone never forces compaction, and sits well below Pi's own threshold of the window less its reserve. Both `auto` sizes also have absolute ceilings (seed 100k, session 200k), because the per-Review cost follows Advisor Session size rather than the window: half of a 1M window is the ~500k-token session measured at $0.12 or more per empty Review; `compaction.reserveTokens` cannot express the cap because it also sizes the summary output, and native auto-compaction could fire mid-Review. Compaction runs after the Review delivers its findings, under its own deadline equal to `reviewTimeoutMs`. Pi declining because nothing precedes its kept recent history is not a failure. Any other failure or timeout, such as an inherited `session_before_compact` handler cancelling it, discards the Advisor Session so the next Review starts from a Context Seed within its budget; it does not pause the Advisor, because the Review succeeded. The Advisor's own record of what it was supplied is unaffected, so the next Review stays incremental, and delivered and deferred findings live outside the Advisor Session. When Context Management is loaded in the Advisor Session, its Rollover replaces native compaction, so the cap is not applied there.

If Context Management is loaded but any of its three required tools is excluded by `allowedTools`, pause the Advisor before reviewing and report a configuration error listing the missing grants. Do not silently grant tools, suppress the extension's hooks, bypass its compaction behavior, or wait for preparation to fail later.

Native compaction preparation may require additional model turns. A saved Handoff or an early assistant answer does not prove that preparation or the Review has finished. Respect native settlement, checkpoint completion, and the standalone direct-call requirement for `context_rollover` when that extension is present.

Private context tools, when granted, do not count against the eight-call investigation limit. The overall Review deadline still bounds investigation and context maintenance together.

Persist the native Advisor journal; do not create an additional transcript-dump format, memory database, or temporary-journal deletion policy.

## Observed context and lifecycle

Seed review with the observed agent's current model-visible conversation, standing instructions, and available reasoning. Fit that Context Seed to `seedBudgetTokens` (default `auto`: a quarter of the Advisor model's context window, at most 100k tokens so it stays within half the `auto` Advisor Session cap; explicit values are capped at that window), measured as Pi's chars/4 estimate of the projected seed JSON plus Pi's exported per-image `estimateTokens` estimate. Always keep the Observed Setup, the original request (the first user-typed message, or after compaction the summary plus the first user-typed message after it, identified by each message's role before `convertToLlm`), and the newest turn with the request that prompted it. Fill the rest with the newest turns that fit; a turn is one message or an assistant message with all its tool results, never split. Shorten text with a marker only where the always-kept messages or the oldest included turn exceed the budget. State which observed messages are kept and where granted tools can find the full ones. Deliver incremental updates afterward; omitted messages count as supplied, so they are not sent later. Do not independently reconstruct unrelated sessions or the entire pre-compaction archive.

Project Review Evidence to what the observed model received: each message's role, text, non-empty reasoning text, tool-call names and arguments, and tool-result text with `isError`. Images travel as native attachments referenced by index. Omit replay signatures, display-only tool `details`, nested-call records, provider/response metadata, timestamps, and native message or tool-call IDs; a tool call and its result instead share a compact Tool-Call Reference derived from the native call ID. Redacted reasoning becomes a bare `redacted` marker. Errored, aborted, or length-truncated observed responses keep their stop reason and any error message as markers. Unknown future roles and content blocks are omitted rather than forwarded. The Context Seed opens with the Observed Setup, which lists observed tools by name and one-line summary rather than full descriptions and schemas. `src/advisor-evidence.ts` owns this projection; Reviews and Consultations both use it.

Rebuild the Advisor's active review context from the current observed context after resume, compaction, or branch changes. Persisted journals do not authorize stale context from an abandoned branch to influence a new Review.

Observe completed native turns: one model response plus its associated tool calls. Enabling arms observation; it does not itself start work in the observed agent.

Disabling, changing effective review configuration, or changing session identity/branch invalidates affected in-flight reviews and undelivered findings. Observed compaction does not: a Review already running finishes on the context it captured, and the next Review rebuilds the Advisor Session from the compacted context. Release Catch-up Waits and use the new current context when reviewing resumes. Already recorded Interventions remain part of their original session branch.

Reviewer cleanup must use the proper native shutdown lifecycle. Raw SDK disposal alone does not notify extension shutdown handlers. Prevent stale asynchronous work from writing advice into another session or generation.

## Scheduling and limits

Reviews run in the background. A Review may combine multiple pending observed turns; do not build an unbounded queue of individual inference requests.

The Review Cadence, `reviewEvery`, decides when a Review is due: `turn` (default) after every completed turn; `N` after every N turns and at request completion; `request` at request completion only. Request completion is the session's `agent_end` that Pi will not automatically retry, after its steering and follow-up messages; the root `agent_settled` hook, headless final drain, and Minimal Subagents task completion also review any remainder. A turn with an errored tool result is due at once under every cadence. A due Review covers every unreviewed turn, using the same incremental evidence as per-turn Reviews; when that evidence would exceed `seedBudgetTokens`, under any cadence, the Advisor Session is rebuilt from a Context Seed instead. As with every rebuild, earlier findings queued for steering but not yet consumed are invalidated and retracted. The default stays `turn`: most Review cost comes from Advisor Session size, which `maxSessionTokens` bounds, and coarser cadences delay findings until the agent has finished, so Concerns can no longer steer the run.

Review Backlog counts completed observed turns not yet fully reviewed, including those under review. The catch-up threshold accepts `off` or any positive integer `N`, defaulting to `3`:

- `off`: never wait for catch-up.
- `N`: wait while backlog is at least `N`; falling below `N` releases the wait. Each wait is capped at 30 seconds.

A threshold of one waits for an empty backlog; larger thresholds do not require a complete flush to zero. Reject zero, negative, and fractional thresholds. Failure, cancellation, disablement, or timeout releases the wait. Catch-up is not an approval gate.

A Catch-up Wait only waits for a running Review. Under a coarser Review Cadence, turns waiting for their cadence point count toward the backlog but never start a wait themselves, and a wait ends when the running Review finishes unless another Review was already due. A Review's compaction runs after it, under its own deadline. A Catch-up Wait waits for that compaction only while unreviewed turns remain at or above its threshold, within the wait's ceiling. The final drain waits for both, up to one Review deadline, and then stops only a Review still under way: a compaction left running keeps its own deadline, the Advisor Session, and deferred findings.

Enforce the configurable Review deadline and investigative-call limit independently of the Catch-up Wait ceiling.

## Interventions and corrective continuation

| Observed state                  | Nit                                      | Concern                                | Blocker                                |
| ------------------------------- | ---------------------------------------- | -------------------------------------- | -------------------------------------- |
| Running                         | Record at the next natural step boundary | Native steer, subject to cooldown      | Native steer                           |
| Normally completed, interactive | Preserve visibly for next continuation   | Preserve visibly for next continuation | Tracked Corrective Turn, within budget |
| Deliberately interrupted        | Preserve; never restart                  | Preserve; never restart                | Preserve; never restart                |
| Aborted or uncertain ending     | Preserve; never restart                  | Preserve; never restart                | Preserve; never restart                |
| Headless root has completed     | Preserve; no hidden turn                 | Preserve; no hidden turn               | Preserve; no hidden turn               |

Pi does not expose every abort cause distinctly. Conservatively preserve advice after any aborted or uncertain ending rather than risk restarting a deliberately stopped run.

Accept at most the configured number of findings from one terminating report, ordered Blocker, Concern, then Nit. Within a Review, retain only the highest-severity copy of formatting-equivalent advice. Across Reviews, suppress equal or lower-severity repeats while permitting `Nit → Concern → Blocker` escalation.

Evaluate the three-completed-turn Concern cooldown once per Review. Deliver all eligible Concerns together; while the cooldown is active, retain the bounded distinct set for re-evaluation. Nits and Blockers bypass this cooldown. Nits never steer or start Corrective Turns. If an asynchronous Review finishes after Pi has begun a turn boundary, native context-only delivery records its Nits at the following safe boundary rather than delaying or waking the Observed Agent.

Known limit: a Blocker delivered while the observed session runs a manual `/compact` does not start a Corrective Turn, because the session is not idle and no later settlement re-checks it; it stays visible for the next continuation.

Allow one automatic Corrective Turn per observed request/task by default, with a configurable limit. Further Blockers remain visible until externally continued. This limit does not prevent steering an already-running turn.

Use bounded, validated, attributed advice output. Do not interpret ordinary context-maintenance narration as an Intervention.

### Finding quality

A finding names a concrete defect in completed work and cites evidence; next-step advice belongs to Consultations, not Interventions. The default Advisor Prompt says so, and `advisor_report` requires an `evidence` object per finding with Tool-Call References (`refs`), a verbatim `quote`, or both, so the requirement survives a replaced prompt. Drop, without failing the Review, any finding that cites neither, or cites a reference not supplied to the current Advisor Session (or cited by a deferred finding it re-validates); the report's tool result names the dropped findings so the Advisor's own history records why. Quotes are not verified: normalizing quoted text against escaped JSON evidence would drop valid findings. An `advisor_report` call that fails the report schema is rejected with its first schema issue; a second rejection in the same Review ends it without findings, counted in status, rather than letting a model that cannot form the new evidence shape retry until the deadline. Rejected report calls do not pause the Advisor, so a corrected report completes the Review normally. Legacy single-finding reports carry no evidence, so their finding is dropped; `severity: "none"` still records an empty Review. The journaled Intervention details keep the evidence; the observed agent's content stays `Advisor <severity>: <message>`, since Tool-Call References are Advisor-side identifiers.

A Superseded Finding comes from a Review whose evidence cutoff (the turns completed when it started) predates turns completed before its delivery. Deliver none of that Review's findings; replace the deferred set with them, so the next Review re-validates them with the newer evidence in the same prompt, without a separate re-check call. That Review is already due under `turn`; under `N` or `request` it comes at the next cadence point, at the latest request completion, whose Review normally has no newer turns, unless an interactive user has already started the next request. Withhold at most once, so continuous turn arrival cannot starve advice: mark each withheld finding, and when a Review given any marked finding is itself superseded, deliver all its Concerns and Blockers (it checked them against newer evidence) and drop, counting, all its Nits. The rule is per Review, not per matched finding, because a re-validating Review may reword a finding or cite newer references. Concerns such a Review defers for the cooldown keep the mark. Check supersession again before each delivery, since turns can complete while earlier findings are sent. A Review ended by invalid reports judged nothing: it marks its turns reviewed but leaves the deferred findings for the next Review. Reset (disable, configuration, branch, session, or pause recovery) drops deferred findings with other stale review state, and a final drain that ends before the re-validating Review finishes drops them with that Review: undelivered unverified findings are not flushed, since delivering them is the staleness this rule prevents.

`maxNitsPerRequest` (default 3, `0` disables Nits) caps Nits delivered per request; Concerns and Blockers are never capped. A request starts at `before_agent_start` for a user prompt (Minimal Subagents: each task's `beginTurn`), the same boundary that resets the Corrective Turn budget, and includes its completion Review and Corrective Turns. Excess Nits are dropped and counted in status, as are findings dropped for evidence, Nits from a superseded re-validating Review, and Reviews ended by invalid reports. The Nit count is derived from the selected branch (Nit Interventions since its latest user message that is not a steer after a tool result, plus queued ones; a follow-up message after a final answer is indistinguishable from a new prompt there, so a rebuild restarts the count at it) whenever review state resets, so configuration or branch changes do not restart or inherit an allowance. Superseded Nits are deferred only within the request's remaining Nit room.

## Headless completion

Headless root sessions allow final reviews up to one Review deadline (`reviewTimeoutMs`), so a Review covering a whole request under a coarse Review Cadence can finish; Minimal Subagents task completion uses the same bound. Preserve completed findings through native session surfaces, stop unfinished reviews, and do not start hidden corrective turns after completion.

This final drain is distinct from ordinary threshold catch-up. Do not wait indefinitely, write unsolicited non-protocol output into a host's stdout, or rely on abandoned background work after the host has finished.

## Minimal Subagents integration

When `pi-minimal-subagents` is present, coverage is main-only or main plus all its descendants. The sibling package is optional; without it, Advisor still works for the main session. There is no per-child Advisor roster initially and no generic third-party child detection promise.

One root Advisor policy governs the watched hierarchy and applies to existing and future children. Unspecified model/thinking follows each observed child's own selections. Policy transfer is independent of transcript context inheritance.

Implement explicit integration with the Minimal Subagents owner for:

- Reliable child identity and root policy propagation.
- Tracked child Review/Corrective Turn completion.
- Cancellation and teardown.
- Parent-visible findings and final task delivery.

An Advisor must not restart a child through a detached prompt after Minimal Subagents has reported its task complete. Corrective continuation remains inside an operation the existing coordinator owns and tracks. Do not reproduce coordinator lifecycle policy or patch around it privately inside Advisor.

## Failures

Use Pi's native retry behavior rather than adding another retry subsystem. If a Review still fails, times out, or cannot resolve its model, pause the Advisor, explain why, and leave the observed agent running. Do not silently switch models.

Explicit re-enablement, corrected configuration, or the settings menu's Resume row retries the Advisor. Pausing does not rewrite enabled settings. Preserve native journal integrity and Context Management's fail-closed handling of checkpoint/storage failures; do not weaken them to conceal an Advisor error.

## Verification and compatibility

The package manifest declares the supported Pi range (`>=0.99.0`); do not re-probe SDK exports, class statics, or methods that range already guarantees. Verify native behavior where it is observable, such as the tool ceiling after binding, and pause with the exact diagnostic when it is not met, keeping the observed session running. Develop against the installed Pi; source checkouts newer than the installed runtime are not API authority.

Use the native SDK `tools` option as the ongoing tool-name ceiling. It filters executable and descriptive registries on refresh, including dynamic registrations; extensions cannot expand the model-callable set merely by calling `setActiveTools`. Verify after binding that no ungranted tool is registered; otherwise pause as unsupported. There is no public ceiling-update setter, so changing the grant requires recreating the private SDK session, not modifying private fields or adding another authorization framework.

Pi's built-in `codemode` does not deactivate granted tools: `codemode.mode: "only"` hides direct declarations while they stay active and callable from scripts. Do not grant `codemode` implicitly or change the inherited mode. Diagnose only an advice tool left inactive after extension binding.

Recreate file-backed extension resources with their original ordering and provenance, including resolved CLI resources. Loaded metadata alone cannot recreate arbitrary inline factories or opaque custom loaders. If fresh instances cannot be reconstructed from available owner-supplied resources, report an unsupported-resource error and pause rather than omit extensions, reuse bound handlers, or guess at closed-over state.

Before release, offline SDK checks must establish:

- Scoped configuration, trust, branch replay, resume/fork behavior, and live root-to-child propagation.
- Inherited extension resources, fresh session-bound handlers, and prevention of recursive Advisor creation.
- Configurable tool grants across registration and activation changes, default read-tool access, and explicit compatibility diagnostics.
- Operation without sibling packages; when Context Management is loaded and granted, private Notes/History/Rollover isolation, durable checkpoints, preparation/overflow behavior, and proper shutdown.
- Correct backlog units, arbitrary positive-integer thresholds, invalid-value rejection, threshold release, timeout/cancellation, failure pause, and bounded review work.
- Nit/Concern/Blocker routing, bounded multi-finding reports, severity escalation, duplicate/cooldown behavior, corrective-turn budgets, and no restart after abort.
- Headless final draining and genuinely tracked child correction/final delivery.
- No stale advice after disable, reload, model/prompt changes, branch navigation, or session replacement.
- Unchanged ordered observed-agent tool definitions, system prompt, and unaffected message history when merely enabling or running a silent Advisor. Name-set equality alone is insufficient cache proof.
- Standalone and combined operation with Context Management, Minimal Subagents, and Pi's built-in `codemode`, using existing fixtures where applicable.

Include a Changeset for every package with releasable implementation changes before opening a PR; follow the repository release gates.

## Relevant existing decisions

- [Publish Pi extensions as source TypeScript](../../../docs/adr/0002-publish-pi-extensions-as-source-typescript.md)
- [Context Management: native durable checkpoints](../../pi-context-management/docs/adr/0001-use-native-compaction-checkpoints.md)
- [Context Management: native compaction policy ownership](../../pi-context-management/docs/adr/0002-let-pi-own-compaction-policy.md)
- [Minimal Subagents: branch-scoped ownership](../../pi-minimal-subagents/docs/adr/0002-branch-scoped-registry-and-child-session-position.md)
