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
The private, durable session in which an Advisor conducts Reviews and manages its own context. When Context Management is available, its Notes, History, and Context Checkpoints belong to the Advisor, not to the observed agent.
_Avoid_: Observed session, shared memory

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
Corrective advice from an Advisor to the observed agent, visible to the user and intended to redirect ongoing work. It neither overrides the user's instructions nor grants the Advisor veto power.
_Avoid_: Veto, approval gate

**Concern**:
An Intervention identifying material risk or a likely wrong direction. A Concern raised after normal completion remains visible for the next continuation rather than restarting the observed agent.
_Avoid_: Nit

**Blocker**:
An urgent Intervention identifying materially unsound work that needs immediate reconsideration, including an unsupported completion claim. It may prompt a corrective continuation after normal completion, but never overrides a deliberate user interruption.
_Avoid_: Execution veto

**Corrective Turn**:
A continuation of the observed agent prompted by a Blocker after normal completion, rather than by a new user request.
_Avoid_: User turn, execution veto

**Review**:
One assessment by an Advisor of new observed-agent context, optionally supported by independent investigation using its Tool Grant. A Review may cover several observed-agent turns.
_Avoid_: Observed-agent turn

**Review Backlog**:
Completed turns of the observed agent that have not yet received a completed Advisor review, including turns currently under review. A turn is one model response and its associated tool calls, not an entire user request.
_Avoid_: Message count, pending advice

**Catch-up Wait**:
A bounded pause in the observed agent's progress while the Advisor reduces its Review Backlog. It is not an approval gate and does not require the Advisor to endorse the work.
_Avoid_: Lockstep review, approval wait
