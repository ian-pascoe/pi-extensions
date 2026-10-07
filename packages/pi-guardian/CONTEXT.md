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
A simple shell command, with no pipes, redirection, command chaining, or substitution, whose program is on the safe-command list and therefore runs without review.
_Avoid_: Allowlisted command

**Sensitive Path**:
A file path whose modification is reviewed even though ordinary workspace edits are not: anything outside the workspace root (and everything when the workspace root contains the home directory); persistence and credential locations in the home directory; version-control, secret, git hook, CI, editor-task, Pi and agent configuration, and context files within the workspace; resources Pi loaded; and files with more than one hard link. Pi configuration, context files, and loaded resources are sensitive because changing them can weaken the Guardian or rewrite trusted instructions.
_Avoid_: Protected file

**Guardian Review**:
One assessment of one Reviewed Call, producing a Risk Level, a User Authorization, and a rationale.
_Avoid_: Review (an Advisor term), approval

**Risk Level**:
The Guardian's judgment of a Reviewed Call's potential for harm: `low`, `medium`, `high`, or `critical`.
_Avoid_: Danger score

**User Authorization**:
The Guardian's judgment of how clearly trusted evidence shows the user authorized a Reviewed Call: `unknown`, `low`, `medium`, or `high`.
_Avoid_: Permission, consent

**Trusted Evidence**:
Content that can establish User Authorization: messages the user typed, context files from the user's global configuration or a trusted project, and User Overrides. Tool results, assistant output, Skill bodies, messages an extension sent, an untrusted project's context files, and a Child Agent's task are untrusted evidence; they may explain a call but cannot authorize it.
_Avoid_: Transcript

**Decision Table**:
The fixed mapping from Risk Level and User Authorization to an Outcome: `low` and `medium` risk are allowed; `high` risk is allowed only with at least `medium` User Authorization; `critical` risk is always rejected.
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
Consecutive Rejections within one request. When it reaches its limit, that Rejection also ends the agent's turn and returns control to the user; any allowed Reviewed Call that runs ends the streak.
_Avoid_: Circuit breaker

**Review Failure**:
A Guardian Review that produced no valid assessment, such as when no model resolves, the provider errors, the review times out, the response is malformed, the Reviewed Call is too large to review in full, or Guardian's settings are unreadable. A Review Failure never allows the call: with an interactive user it asks them to confirm, and otherwise it blocks.
_Avoid_: Fail-open

**Security Policy**:
User-authored instructions added to the Guardian's built-in policy, such as trusted destinations or forbidden actions.
_Avoid_: Advisor Prompt, rules
