---
name: pi-guardian
description: Diagnose Pi Guardian when tool calls are unexpectedly blocked or allowed, Guardian Reviews fail or time out, settings seem ineffective, Child Agents or Advisors behave differently, or reviews cost too much.
license: MIT
disable-model-invocation: true
---

# Pi Guardian

Use this sequence for a live Guardian problem:

1. Run `/guardian status`. Record the state, each setting and its source, the review counts (allowed, rejected, failed, overrides, argument drift), total cost, and the last failure. Treat unknown cost as unknown, not zero. Expand the newest `pi-guardian-review` entries in the transcript for the tool, scores, rationale, failure, model, and duration of each Guardian Review.
2. If the state is `error`, read the message: invalid `guardian` settings in the global or trusted-project `settings.json`, an invalid session override, or an unreadable session. Correct it; until then every call that needs review fails closed.
3. If a call was blocked without a Guardian Review, check its Tool Policy. A `deny` Tool Policy blocks without a model call. Resolution order: `tools.<name>` setting, then the built-in default (read-only tools allowed; `edit`/`write` allowed except for Sensitive Paths; `bash` allowed only for Safe Commands), then the tool's `readOnlyHint` annotation, then review. Change one entry with `/guardian tool <name> <allow|review|deny|default|inherit>` at the intended scope (`--global`, `--project`, or the session by default).
4. If a `bash` command you consider safe is reviewed, it is not a Safe Command: pipes, redirection, chaining, substitutions, variables, globs, `~`, quotes left open, or programs outside the built-in list all send it to review. Add a literal command prefix to `safeCommands` (for example `["npm test"]`); entries match leading words and the rest of the command must still be literal.
5. If an edit is reviewed, its path is a Sensitive Path: outside the working directory after resolving `~`, `..`, and symlinks; inside `.git`, `.pi`, or a `.env*` file or directory; or under Pi's agent directory or session directory.
6. For Review Failures, read the failure: no model resolves (set `model` to `provider/id` or select a session model), no credentials for that model, a provider error, a timeout (`reviewTimeoutMs`), or malformed output (the model did not return the assessment JSON; choose a stronger model or raise `thinkingLevel`). With UI, Guardian asks whether to allow once; without UI it blocks.
7. For a Rejection you disagree with, check the rationale against Trusted Evidence: only messages the user typed, project instructions, and recorded User Overrides establish User Authorization. Tool output, assistant text, and a Child Agent's task cannot. Tell the agent in your own message that you authorize the exact action, add rules to the Security Policy (`/guardian policy`), or set `onDeny` to `ask` to allow once interactively.
8. If the agent stopped after Rejections, the Rejection Streak reached `maxConsecutiveRejections` (default 3; 0 disables). Blocked Review Failures count too. Pi ends the turn only when every call in the tool batch asked to stop.
9. If a Child Agent or Advisor behaves differently, check `/guardian status` in that session for `follows root`: Child Agents and Advisors follow the root session's effective settings while the root runs Guardian in the same process, and fall back to their own settings otherwise. Their user messages come from another agent and are untrusted, and they have no UI, so Review Failures block.
10. If `/guardian status` reports argument drift, an extension loaded after Guardian changed the call's arguments after review. Load Guardian last.
11. If reviews cost too much, compare the total review cost with the session cost. Allow more read-only tools or Safe Commands, lower `evidenceBudgetTokens`, choose a cheaper `model`, or lower `thinkingLevel`.

Finish when `/guardian status` shows the intended settings and the problematic call is allowed, reviewed, or blocked as its Tool Policy and Decision Table say. If a model or provider remains unavailable, report the exact failure instead of disabling Guardian.
