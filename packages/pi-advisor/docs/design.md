# Pi Advisor design

Status: accepted and implemented.

Package: `@ian-pascoe/pi-advisor`.

The [Advisor glossary](../CONTEXT.md) defines the domain terms. This document records the agreed behavior, not a replacement compaction or agent framework.

## Purpose and authority

An Advisor reviews an observed agent's work and offers corrective advice. Default review priorities are instruction violations, scope drift, repeated failures, and unsupported completion claims. It stays silent when there is no material finding.

The Advisor Prompt is replaceable. Permissions, attribution, delivery rules, and limits remain enforced outside that prompt. Standing instructions and observed conversation content are review evidence, not permission to expand the Advisor's capabilities.

Interventions are user-visible and attributed to the Advisor. They use Pi's native steering boundary; they do not veto actions, cancel running tools, or override user instructions. There is no nit tier.

One Advisor watches each participating agent session. Advisors are not ordinary task-performing Child Agents, and must never recursively create Advisors for their own sessions.

## Configuration and controls

All Advisor options support global, trusted-project, and session scopes:

1. Explicit session override.
2. Trusted project setting.
3. Global setting.
4. Package default.

Unset means inherit, not disabled. Prompt overrides replace the whole value rather than concatenate prompts. An explicit `allowedTools` list replaces the inherited list. Global disable is an overridable default, not a master kill switch.

Use native Pi settings files and native session entries, not a separate configuration store. Session overrides follow the selected branch, survive resume, and inherit through forks; abandoned branch state is excluded.

Provide commands for on/off/inherit, scoped configuration, and status. Use Pi's native editor for prompt editing rather than a custom dashboard. Status shows effective settings and their sources, review state, backlog, usage/cost, and the last error. Unknown cost must not be presented as zero.

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
| Per-review deadline            | 120 seconds; configurable                    |
| Investigative tool-call limit  | 8 per Review; configurable                   |
| Automatic Corrective Turns     | 1 per observed request/task; configurable    |

Model and thinking overrides are independent. Do not silently select another provider or model when resolution or inference fails.

## Extension inheritance and tool access

Load the observed/main session's extensions in the Advisor Session, using fresh session-bound factory instances rather than copying parent-bound handlers or tools. Inheriting `pi-advisor` must not recursively create another Advisor. This supersedes the earlier Context-Management-only extension allowlist.

Configure a tool-name allowlist, `allowedTools`, defaulting to `read`, `grep`, `find`, and `ls`. It replaces the separate investigation enable/disable option. Users can add extension tools such as `lsp`, `context_notes`, `context_history`, and `context_rollover`. The Advisor's constrained advice-output mechanism remains intrinsic rather than requiring an entry in this list.

Tool permission and extension loading are distinct: loading an extension does not automatically grant its tools. Sibling extensions are optional; their absence must not make `pi-advisor` a missing-dependency error.

The standard implementations of the default tool names are read-only, but **not a filesystem sandbox**: they may read paths outside the project that Pi's OS account can access. Inherited extensions can replace those implementations. No bespoke confinement layer is requested, and the default list grants no shell-command tool name.

The Advisor is **read-only by default, not by invariant**. An explicit tool-name grant permits that tool's full interface, subject to the tool's native policies; for example, granting `lsp` includes its mutation operations. Do not add per-operation permission filters or silently expand the configured grant through aliases or replacement tool bundles.

Loaded extensions remain privileged code. Their hooks can have effects outside model tool calls; `allowedTools` is not a sandbox for extension behavior.

Ignore configured tool names that are unavailable, and report those names in status. This permits one configuration across different installed extension sets without hiding misspellings. A loaded extension requiring tools excluded by the grant is a separate compatibility issue, not the same as an absent optional extension.

The Advisor retains its own prompt and session state. Supply the observed agent's standing instructions deliberately as review context rather than transplanting its assembled operating context or private state. Preserve inherited extensions' normal session-local hooks and instructions.

## Advisor Session and optional Context Management

Each Advisor continues to use a private, persisted native Pi session. This storage decision remains in place, but Context Management is no longer a mandatory dependency or an automatically granted tool set.

When Context Management is present among the inherited extensions, users can grant its tools through `allowedTools`:

- `context_notes`
- `context_history`
- `context_rollover`

When granted, these tools operate on the Advisor's own Notes, History, and Context Checkpoints—not those of the observed agent. References copied from the observed conversation do not grant access to the observed session's private store.

Pi owns the agent loop, session journal, compaction policy, context accounting, and retention of recent conversation. Without Context Management, use ordinary native compaction. When loaded, Context Management replaces native summarization with Notes/Handoff preparation and durable native Context Checkpoints. Do not add another compaction policy or bypass its durability guards.

If Context Management is loaded but any of its three required tools is excluded by `allowedTools`, pause the Advisor before reviewing and report a configuration error listing the missing grants. Do not silently grant tools, suppress the extension's hooks, bypass its compaction behavior, or wait for preparation to fail later.

Native compaction preparation may require additional model turns. A saved Handoff or an early assistant answer does not prove that preparation or the Review has finished. Respect native settlement, checkpoint completion, and the standalone direct-call requirement for `context_rollover` when that extension is present.

Private context tools, when granted, do not count against the eight-call investigation limit. The overall Review deadline still bounds investigation and context maintenance together.

Persist the native Advisor journal; do not create an additional transcript-dump format, memory database, or temporary-journal deletion policy.

## Observed context and lifecycle

Seed review with the observed agent's current model-visible conversation, standing instructions, and available reasoning. Deliver incremental updates afterward. Do not independently reconstruct unrelated sessions or the entire pre-compaction archive.

Rebuild the Advisor's active review context from the current observed context after resume, compaction, or branch changes. Persisted journals do not authorize stale context from an abandoned branch to influence a new Review.

Observe completed native turns: one model response plus its associated tool calls. Enabling arms observation; it does not itself start work in the observed agent.

Disabling, changing effective review configuration, or changing session identity/branch invalidates affected in-flight reviews and undelivered findings. Release Catch-up Waits and use the new current context when reviewing resumes. Already recorded Interventions remain part of their original session branch.

Reviewer cleanup must use the proper native shutdown lifecycle. Raw SDK disposal alone does not notify extension shutdown handlers. Prevent stale asynchronous work from writing advice into another session or generation.

## Scheduling and limits

Reviews run in the background. A Review may combine multiple pending observed turns; do not build an unbounded queue of individual inference requests.

Review Backlog counts completed observed turns not yet fully reviewed, including those under review. The catch-up threshold accepts `off` or any positive integer `N`, defaulting to `3`:

- `off`: never wait for catch-up.
- `N`: wait while backlog is at least `N`; falling below `N` releases the wait. Each wait is capped at 30 seconds.

A threshold of one waits for an empty backlog; larger thresholds do not require a complete flush to zero. Reject zero, negative, and fractional thresholds. Failure, cancellation, disablement, or timeout releases the wait. Catch-up is not an approval gate.

Enforce the configurable Review deadline and investigative-call limit independently of the Catch-up Wait ceiling.

## Interventions and corrective continuation

| Observed state                  | Concern                                | Blocker                                |
| ------------------------------- | -------------------------------------- | -------------------------------------- |
| Running                         | Native steer, subject to cooldown      | Native steer                           |
| Normally completed, interactive | Preserve visibly for next continuation | Tracked Corrective Turn, within budget |
| Deliberately interrupted        | Preserve; never restart                | Preserve; never restart                |
| Aborted or uncertain ending     | Preserve; never restart                | Preserve; never restart                |
| Headless root has completed     | Preserve; no hidden turn               | Preserve; no hidden turn               |

Pi does not expose every abort cause distinctly. Conservatively preserve advice after any aborted or uncertain ending rather than risk restarting a deliberately stopped run.

At most one Intervention is accepted per Review. Suppress identical and formatting-only duplicates. Require three completed observed-agent turns between Concerns. Blockers bypass that cooldown, not duplicate suppression or the per-Review limit. Reconsider deferred Concerns before delivery rather than blindly flushing stale findings.

Allow one automatic Corrective Turn per observed request/task by default, with a configurable limit. Further Blockers remain visible until externally continued. This limit does not prevent steering an already-running turn.

Use bounded, validated, attributed advice output. Do not interpret ordinary context-maintenance narration as an Intervention.

## Headless completion

Headless root sessions allow up to 30 seconds for final reviews. Preserve completed findings through native session surfaces, stop unfinished reviews, and do not start hidden corrective turns after completion.

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

Explicit re-enablement or corrected configuration retries the Advisor. Pausing does not rewrite enabled settings. Preserve native journal integrity and Context Management's fail-closed handling of checkpoint/storage failures; do not weaken them to conceal an Advisor error.

## Verification and compatibility

Target the installed Pi 0.85.1 development baseline and check actual exports/capabilities against the package's declared compatibility range. Source checkouts newer than the installed runtime are not API authority.

Use the native SDK `tools` option as the ongoing tool-name ceiling. It filters executable and descriptive registries on refresh, including dynamic registrations; extensions cannot expand the model-callable set merely by calling `setActiveTools`. There is no public ceiling-update setter, so changing the grant requires recreating the private SDK session, not modifying private fields or adding another authorization framework.

Permission does not guarantee exposure. Inherited CodeMode-only exposure with no permitted CodeMode execution tools can leave the default read grant inactive. Diagnose such incompatible grants/exposure settings clearly rather than silently granting execution tools or changing the inherited exposure mode.

Recreate file-backed extension resources with their original ordering and provenance, including resolved CLI resources. Loaded metadata alone cannot recreate arbitrary inline factories or opaque custom loaders. If fresh instances cannot be reconstructed from available owner-supplied resources, report an unsupported-resource error and pause rather than omit extensions, reuse bound handlers, or guess at closed-over state.

Before release, offline SDK checks must establish:

- Scoped configuration, trust, branch replay, resume/fork behavior, and live root-to-child propagation.
- Inherited extension resources, fresh session-bound handlers, and prevention of recursive Advisor creation.
- Configurable tool grants across registration and activation changes, default read-tool access, and explicit compatibility diagnostics.
- Operation without sibling packages; when Context Management is loaded and granted, private Notes/History/Rollover isolation, durable checkpoints, preparation/overflow behavior, and proper shutdown.
- Correct backlog units, arbitrary positive-integer thresholds, invalid-value rejection, threshold release, timeout/cancellation, failure pause, and bounded review work.
- Concern/Blocker routing, duplicate/cooldown behavior, corrective-turn budgets, and no restart after abort.
- Headless final draining and genuinely tracked child correction/final delivery.
- No stale advice after disable, reload, model/prompt changes, branch navigation, or session replacement.
- Unchanged ordered observed-agent tool definitions, system prompt, and unaffected message history when merely enabling or running a silent Advisor. Name-set equality alone is insufficient cache proof.
- Standalone and combined operation with Context Management, Minimal Subagents, and CodeMode, using existing fixtures where applicable.

Include a Changeset for every package with releasable implementation changes before opening a PR; follow the repository release gates.

## Relevant existing decisions

- [Publish Pi extensions as source TypeScript](../../../docs/adr/0002-publish-pi-extensions-as-source-typescript.md)
- [Context Management: native durable checkpoints](../../pi-context-management/docs/adr/0001-use-native-compaction-checkpoints.md)
- [Context Management: native compaction policy ownership](../../pi-context-management/docs/adr/0002-let-pi-own-compaction-policy.md)
- [Minimal Subagents: branch-scoped ownership](../../pi-minimal-subagents/docs/adr/0002-branch-scoped-registry-and-child-session-position.md)
