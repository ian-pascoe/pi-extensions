# Advisor context

The Advisor context provides review of agent sessions and corrective advice when work departs from the user's request or instructions.

## Language

**Advisor**:
A reviewer that watches an agent session for instruction violations, scope drift, repeated failures, and unsupported completion claims, according to its Advisor Prompt. Its default Tool Grant selects the standard read tools, but explicit grants may permit broader capabilities.
_Avoid_: Guard, executor

**Observed Agent**:
The agent whose work an Advisor reviews, whether the main Pi agent or a participating Minimal Subagents Child Agent. Its session state is distinct from the Advisor Session.
_Avoid_: Advisor

**Advisor Session**:
The private, durable session in which an Advisor conducts Reviews and manages its own context. Past a configured size, Pi's native compaction summarizes its older history; when Context Management is available, its Notes, History, and Context Checkpoints belong to the Advisor, not to the observed agent.
_Avoid_: Observed session, shared memory

**Advisor thinking level**:
The reasoning level of an Advisor Session. Unless configured it is a fixed `high`, independent of the Observed Agent's thinking level.
_Avoid_: Inherited thinking level

**Advisor cache retention**:
The prompt-cache lifetime an Advisor requests for its own Advisor Session, as a per-request option rather than a process-wide setting, so the Observed Agent's requests are unchanged. OpenAI's 24h retention is always requested; Anthropic's 1h cache TTL is opt-in (`anthropicLongCache`) because its writes cost 2× instead of 1.25×.
_Avoid_: `PI_CACHE_RETENTION`, cache warming

**Paused Advisor**:
An enabled Advisor that has stopped reviewing after a failure and requires recovery before it can resume. Pausing does not disable its configuration or stop the observed agent.
_Avoid_: Disabled Advisor

**Advisor Prompt**:
The configurable review instructions that define what an Advisor should look for when evaluating an agent's work.
_Avoid_: Main-agent prompt

**Tool Grant**:
The configured set of tools an Advisor is permitted to call, distinct from the extensions loaded in its Advisor Session. A grant covers the tool's full interface, subject to that tool's native policies.
_Avoid_: Extension allowlist

**Intervention**:
Actionable advice from an Advisor to the observed agent about a concrete defect in its completed work, citing Review Evidence, visible to the user and intended to improve or redirect ongoing work. Advice about what to do next belongs to a Consultation instead. It neither overrides the user's instructions nor grants the Advisor veto power.
_Avoid_: Veto, approval gate

**Nit**:
A non-interrupting Intervention identifying worthwhile low-risk cleanup, simplification, style, or a missed opportunity in completed work. It enters the observed context at a natural step boundary and never starts a Corrective Turn. At most `maxNitsPerRequest` Nits are delivered per request.
_Avoid_: Concern

**Concern**:
An Intervention identifying material risk or a likely wrong direction. A Concern raised after normal completion remains visible for the next continuation rather than restarting the observed agent.
_Avoid_: Nit

**Blocker**:
An urgent Intervention identifying materially unsound work that needs immediate reconsideration, including an unsupported completion claim. It may prompt a corrective continuation after normal completion, but never overrides a deliberate user interruption.
_Avoid_: Execution veto

**Superseded Finding**:
A finding from a Review whose observed agent completed more turns before the finding could be delivered. It is withheld and re-validated by the next Review against the newer turns rather than delivered, at most once: if that Review is superseded too, its Concerns and Blockers are delivered and its Nits dropped.
_Avoid_: Retracted finding

**Corrective Turn**:
A continuation of the observed agent prompted by a Blocker after normal completion, rather than by a new user request.
_Avoid_: User turn, execution veto

**Review**:
One assessment by an Advisor of new observed-agent context, optionally supported by independent investigation using its Tool Grant. A Review may cover several observed-agent turns and produce a bounded set of findings.
_Avoid_: Observed-agent turn

**Review Cadence**:
When Reviews start: after every turn (the default), after every N turns and at request completion, or once at request completion. A turn with a failed tool call starts a Review under any cadence. Whatever the cadence, a Review covers the whole Review Backlog.
_Avoid_: Review frequency, polling interval

**Review Evidence**:
The observed agent's messages as its model received them, supplied to a Review or Consultation: roles, text, reasoning text, tool calls with arguments, tool-result text with error status, image attachments, and markers for redacted reasoning and responses that ended abnormally. Replay signatures, display-only details, provider metadata, and native IDs are omitted.
_Avoid_: Transcript dump, raw session messages

**Context Seed**:
The first Review Evidence an Advisor Session receives, in its first Review or Consultation: the Observed Setup plus the current conversation, fitted to a token budget counted in the Advisor model's reported tokens, which Advisor estimates from Pi's chars/4 count scaled by a factor it learns per model. It always keeps the original request (the first user-typed message, or after compaction the summary plus the first user-typed message after it) and the newest turn with its request, then the newest turns that fit; a turn is never split from its tool results, and oversized text is shortened with a marker. It states which observed messages it keeps. Omitted messages count as seen. Later Reviews and Consultations add only messages the Advisor has not yet seen, until the Advisor Session is rebuilt, including when those messages would exceed the budget.
_Avoid_: Snapshot

**Observed Setup**:
The part of a Context Seed that describes the observed agent rather than its conversation: the observed system prompt and each observed tool's name with a one-line summary, without full descriptions or schemas.
_Avoid_: Context

**Tool-Call Reference**:
A compact identifier, derived from the native tool-call ID, that links an observed tool call to its result in Review Evidence and stays the same across projections.
_Avoid_: Tool-call ID

**Consultation**:
An on-demand exchange in which the main Observed Agent asks its existing Advisor for analysis or a second opinion. A Consultation returns advice directly, does not complete a Review, and does not create an Intervention or Corrective Turn.
_Avoid_: Delegation, manual Review

**Review Backlog**:
Completed turns of the observed agent that have not yet received a completed Advisor review, including turns currently under review. A turn is one model response and its associated tool calls, not an entire user request.
_Avoid_: Message count, pending advice

**Catch-up Wait**:
A bounded pause in the observed agent's progress while the Advisor reduces its Review Backlog. It waits only for a running Review, never for turns that are waiting for their Review Cadence. It is not an approval gate and does not require the Advisor to endorse the work.
_Avoid_: Lockstep review, approval wait
