# Guardian context

The Guardian context gates an agent's tool calls by having a separate model judge their risk and the user's authorization before they run.

## Language

**Guardian**:
A reviewer model that decides whether a Reviewed Call may run, judging its risk against the user's authorization. Unlike an Advisor, it acts before execution and its Rejection is binding on the agent.
_Avoid_: Advisor, classifier, sandbox

**Guarded Agent**:
The agent whose tool calls a Guardian reviews: the main Pi agent, a Minimal Subagents Child Agent, or an Advisor in its Advisor Session.
_Avoid_: Observed Agent

**Tool Policy**:
The configured treatment of a tool's calls: `allow` runs them without review, `review` sends them to the Guardian, and `deny` blocks them outright. A tool with no configured, built-in, or annotated Tool Policy is reviewed.
_Avoid_: Approval mode, permission tier

**Reviewed Call**:
A tool call that its Tool Policy and call-specific exemptions send to the Guardian. A call issued by another tool, such as a codemode script, is judged by its own Tool Policy, with the issuing call as context.
_Avoid_: Dangerous call, risky call

**Safe Command**:
A shell command that runs without review: one or more segments joined by `|`, `&&`, `||`, or `;`, each of literal words with no redirection, substitution, or expansion, whose program is on the safe-command list or matches an `allow` Command Rule.
_Avoid_: Allowlisted command

**Command Rule**:
A user's treatment of `bash` commands starting with a literal prefix: `allow` makes matching segments Safe Commands, `review` sends the command to the Guardian, and `deny` blocks it without a Guardian Review. A rule matches only a segment whose leading words are literal; the longest matching prefix wins, and any `deny` segment denies the whole command.
_Avoid_: Safe command list, allowlist entry

**Sensitive Path**:
A file path whose modification is reviewed even though ordinary workspace edits are not: anything outside the workspace root (and everything when the workspace root contains the home directory); persistence and credential locations in the home directory, and the same dotfile names anywhere in the workspace; version-control, secret, git hook, CI, editor, package-manager hook, Pi and agent configuration, and context files within the workspace; resources Pi loaded, except extensions inside the workspace, which are project code; and files with more than one hard link. Pi configuration, context files, and loaded resources are sensitive because changing them can weaken the Guardian or rewrite trusted instructions.
_Avoid_: Protected file

**Guardian Review**:
One assessment of one Reviewed Call, producing a Risk Level, a User Authorization, a Risk Category when the risk is `high` or `critical`, and a rationale. A first pass whose assessment would be rejected is followed by an Escalation Pass.
_Avoid_: Review (an Advisor term), approval

**Escalation Pass**:
A second, careful completion of a Guardian Review whose first pass would be rejected: the same request plus an instruction to reason before answering, with the escalation model and thinking level. Its assessment decides the Outcome; when it fails, the first pass's Rejection stands.
_Avoid_: Retry, appeal, second opinion

**Risk Level**:
The Guardian's judgment of a Reviewed Call's potential for harm: `low`, `medium`, `high`, or `critical`.
_Avoid_: Danger score

**Risk Category**:
The concrete reason a Reviewed Call is `high` or `critical` risk, from a closed list: `data_egress`, `credential_access`, `destruction`, `persistence`, `sensitive_path`, `safety_weakening`, `remote_code`, `unreviewed_execution`, and, when the user configured a Security Policy or a `deny` Command Rule, `security_policy`. A `high` or `critical` Risk Level without one is asked about once more, then decided as `medium`.
_Avoid_: Reason code

**User Authorization**:
The Guardian's judgment of how clearly trusted evidence shows the user authorized a Reviewed Call: `unknown`, `low`, `medium`, or `high`.
_Avoid_: Permission, consent

**Evidence**:
What a Guardian Review sees besides the Reviewed Call: context files, the user's messages, User Overrides, Approved Delegations, and the Guarded Agent's earlier tool calls. It is reasoning-blind: the agent's text and reasoning, tool results, other extensions' messages, and compaction and branch summaries are left out.
_Avoid_: Transcript, context

**Trusted Evidence**:
Evidence that can establish User Authorization: messages the user typed, context files from the user's global configuration or a trusted project, User Overrides, and Approved Delegations. The agent's tool calls, Skill bodies, messages an extension sent, an untrusted project's context files, and a Child Agent's task that no Guardian approved are untrusted evidence; they may explain a call but cannot authorize it. For a Child Agent's or Advisor's calls, the root session user's typed messages are Trusted Evidence.
_Avoid_: Transcript

**Approved Delegation**:
A Child Agent's task or Coordination Message from its direct parent that the parent's Guardian reviewed and allowed, or the parent's user allowed once. It is Trusted Evidence in the Child Agent, written by the delegating agent and bounded by what that Guardian judged the user to have requested. A delegation an `allow` Tool Policy let through unreviewed is not approved.
_Avoid_: Trusted task, delegated authority

**Decision Table**:
The fixed mapping from Risk Level and User Authorization to an Outcome, where a `high` or `critical` Risk Level still without a Risk Category after its corrective retry counts as `medium`: `low` and `medium` risk are allowed; `high` risk is allowed only with at least `medium` User Authorization; `critical` risk is always rejected.
_Avoid_: Threshold

**Outcome**:
The result of a Guardian Review as derived by the Decision Table: allowed or rejected.
_Avoid_: Verdict

**Rejection**:
A blocked Reviewed Call, reported to the Guarded Agent with the Guardian's rationale and an instruction not to circumvent it but to ask the user. The user may then authorize the action in conversation, which a later Guardian Review weighs as Trusted Evidence.
_Avoid_: Veto, denial

**User Override**:
A user's interactive decision to run a call that a Rejection or Review Failure would have blocked. Later Guardian Reviews weigh it as Trusted Evidence that authorizes only that exact call.
_Avoid_: Bypass

**Rejection Streak**:
Consecutive blocked Reviewed Calls within one request: Rejections and blocked Review Failures. When it reaches its limit, Guardian ends the agent's turn and returns control to the user, blocking every further call until the user's next prompt, steering, or follow-up message; before that, any allowed Reviewed Call that runs ends the streak, and so does any message the user types.
_Avoid_: Circuit breaker

**Review Failure**:
A Guardian Review that produced no valid assessment, such as when no model resolves, the provider errors, the review times out, the response is malformed, the Reviewed Call is too large to review in full, or Guardian's settings are unreadable. A Review Failure never allows the call: with an interactive user it asks them to confirm, and otherwise it blocks.
_Avoid_: Fail-open

**Security Policy**:
User-authored instructions added to the Guardian's built-in policy, such as trusted destinations or forbidden actions. A call that violates it is `security_policy` risk; hard limits that must never depend on a model belong in Command Rules or `deny` Tool Policies.
_Avoid_: Advisor Prompt, rules
