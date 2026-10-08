# Pi Guardian

`@ian-pascoe/pi-guardian` gates a Pi agent's tool calls before they run. Routine calls run at once; calls a Tool Policy sends to review go to a separate reviewer model, the Guardian, which judges the call's risk against the user's authorization. A fixed Decision Table turns that judgment into an allowed call or a binding Rejection.

Requires Node `>=22.19.0` and Pi `>=1.1.0`.

> **Guardian is a safety net, not a sandbox.** An allowed call runs with your full privileges, a reviewer model can be wrong or manipulated, and other extensions can still act on their own. Keep backups and review what agents do.

## Install

```bash
pi install npm:@ian-pascoe/pi-guardian
# or from this checkout
pi -e ./packages/pi-guardian/src/index.ts
```

**Install Guardian last.** Pi runs `tool_call` handlers in extension load order, and an extension loaded after Guardian can rewrite a call's arguments after Guardian reviewed them. Guardian detects this after the call runs (see [Limitations](#limitations)).

Guardian is **disabled by default**: installing it changes nothing until you turn it on with `/guardian on --global` (or `--project`, or for the session without a flag), the Enabled row of `/guardian`, or `"enabled": true` in settings. Once enabled, it reviews with the session's current model unless `model` is set. Without a usable model, every call that needs review is a Review Failure. Invalid `guardian` settings fail closed even so, since they may have enabled it (see below).

**Choose a small, fast Guardian model with thinking off.** Every Reviewed Call waits for its review, and a large session model makes that slow and costly: in live use, Claude Opus took 6 to 17 s and about $0.27 per review, while `anthropic/claude-haiku-4-5` with `thinkingLevel: "off"` took about 1.4 s and $0.05. Set both in `/guardian` (Model, thinking level) or in settings, as in the [example](#settings). A would-be Rejection is rechecked by an [Escalation Pass](#escalation-pass), with thinking `low` by default, so the fast first pass need not be careful on its own. While `model` is unset, Guardian shows a one-time notice at session start, and `/guardian status` marks the model as inherited from the session.

**Or let a classifier make the First Pass.** With `classifierModel` set to a Pi classifier model such as TypeSafe's `typesafe/jev-latest`, a [classifier First Pass](#classifier-first-pass) answers in well under a second and escalates to a language model only when it would reject, is unsure, or fails.

## How a call is judged

Every `tool_call`, including calls a tool issues itself (such as a `codemode` script's calls, which carry `parentToolCallId`), resolves to one Tool Policy:

1. for `bash`, `terminal_start`, and `powershell`, `deny` when a segment of the command matches a `deny` **Command Rule** (see below), whatever the tool's Tool Policy;
2. the configured `tools.<name>` setting, if any;
3. else the built-in default:
   - `allow`: `read`, `grep`, `find`, `ls`, `codemode`, `tool_search`, `todo`, `web_search`, and Context Management's `context_notes`, `context_history`, and `context_rollover`, which only touch the session's own notes, journal, and handoff;
   - `edit` and `write`: `allow`, unless the target is a **Sensitive Path**, which is reviewed;
   - `bash`: `allow` only for a **Safe Command**, otherwise reviewed;
   - `terminal_start`, `terminal_send`, and `powershell`: reviewed, with the user's `deny` and `review` Command Rules named to the Guardian; a `terminal_start` or `powershell` command matching a `deny` rule is denied like `bash`;
4. else the tool's `readOnlyHint: true` annotation (as reported by `pi.getAllTools()`) allows it, unless it also declares `openWorldHint: true`;
5. else the call is reviewed.

`deny` blocks the call without a model call. `review` sends it to a Guardian Review. A nested call is judged by its own Tool Policy; the issuing call is shown to the Guardian as context only.

While Guardian's settings cannot be read (invalid `guardian` settings or an unreadable session), every call except the built-in `read`, `grep`, `find`, and `ls` is a Review Failure: the unreadable settings may have held `deny` or `review` rules, so neither they nor the built-in defaults apply. The footer shows `✗ guardian settings error`, and the error is reported when the session starts and in each blocked call's reason.

**Sensitive Paths** are judged after resolving `~`, `..`, `@`, `file://`, and symlinks (including dangling ones), on both the lexical and the resolved path:

- anything outside the working directory, and **every** path when the working directory is the home directory, an ancestor of it, or `/`;
- persistence and credential locations under the home directory wherever the workspace is: shell startup files (`.bashrc`, `.bash_profile`, `.bash_aliases`, `.profile`, `.zshrc`, `.zprofile`, `.zshenv`, and similar), `.ssh`, `.gnupg`, `.aws`, `.azure`, `.config` (including fish and systemd user units), `bin`, `.local/bin`, `.cargo/bin`, `Library/LaunchAgents`, `.gitconfig`, `.git-credentials`, `.npmrc`, `.yarnrc`, `.pypirc`, `.netrc`, `.docker`, and `.kube`; system crontabs are outside any workspace;
- inside the workspace, any case and at any depth: `.git`, `.pi`, `.agents`, `.claude`, `.env*` (including `.envrc`), `.husky`, `.github/workflows`, `.vscode`, `.idea`, `.yarnrc.yml`, `.pnpmfile.cjs`, the persistence names above (so a stow-style `dotfiles/bash/.bashrc` counts, since linking or copying it installs it), and context files named `AGENTS.md`, `AGENTS.override.md`, or `CLAUDE.md`;
- Pi's agent directory (`getAgentDir()`), the session directory, and every resource Pi loaded into the session: context files, Skills (their whole directory), prompt templates, system prompt files, and extensions outside the workspace. Extensions inside the workspace are ordinary project code: a change to them runs only after the user reloads, and in a repository that develops extensions every edit would otherwise be reviewed;
- an existing file with more than one hard link, since editing it in place changes the other paths too;
- on Windows, a path with backslashes or a drive letter, which Guardian does not judge.

Pi configuration, context files, and loaded resources are sensitive because changing them can weaken Guardian or rewrite the instructions it trusts. The reason shown to the Guardian lists every rule that matched, for the path as written and as resolved, quotes path names (so a name with a newline cannot forge a line of the Reviewed Call), and says where a symlinked path resolves.

A **Safe Command** is one or more segments joined by `|`, `&&`, `||`, or `;`, each a simple command of literal words: no redirection (except `2>/dev/null` and `2>&1`, below), `&`, `|&`, subshells, grouping, command or process substitution, backticks, newlines or other control characters, variable, tilde, brace or history expansion, globbing, comments, escapes, or environment assignments, and a bare program name (no path). Quotes are read the way bash and `sh` read them, which holds only while Pi's `shellPath` is unset, `bash`, or `sh`; under any other shell (fish, PowerShell, zsh, …) no built-in program is a Safe Command, since such shells can end a quote early (PowerShell reads curly quotes as quotes) and so split a command's arguments differently than Guardian checked; only commands that an `allow` Command Rule covers, with no shell syntax even inside quotes and no redirect, still run unreviewed. Under bash and `sh`: inside single quotes every character is literal, and inside double quotes only `$`, a backtick, `\`, and `!` are special, so `grep -n "render(40)" file` and `grep -E 'a|b' src` qualify while `echo "$(rm x)"` and `echo "hi!"` are reviewed, as is any command with an unterminated quote. A `;`, `|`, or `&&` inside quotes is text, not an operator. So `grep -rn TODO src | head -20` and `ls src && git status` qualify because every segment does, while `cat x | sh`, `grep -l a src | xargs rm`, and `ls && rm -rf x` are reviewed. The built-in programs are `ls`, `pwd`, `cat`, `head`, `tail`, `wc`, `echo`, `stat`, `du`, `df`, `basename`, `dirname`, `realpath`, `which`, `whoami`, `uname`, `grep`, `rg` (without `--pre`, `--pre-glob`, or `--hostname-bin`), `find` (without `-exec`, `-execdir`, `-ok`, `-okdir`, `-delete`, `-fprint`, `-fprint0`, `-fprintf`, or `-fls`), and `git status`, `git log`, `git diff`, `git show` (without `--output`, `--ext-diff`, or `--textconv`), `git branch` (listing flags only), and `git rev-parse`, with no git options before the subcommand, and `sed` only as `sed -n '<address>p' file…`, where the address is a line number, `$`, a `/regex/` without `/` or `\`, or a range of two of them (`5p`, `10,20p`, `$p`, `/start/,/end/p`): `-e`, `-f`, `-i`, `-s`, any other option or script (`w`, `e`, `r`, `s`, a second command), and options after the script are reviewed. A segment may carry `2>/dev/null` or `2>&1`, each as a word of its own: `grep -rn x src 2>/dev/null | head` qualifies, but `>/dev/null`, `2>file`, `&>`, `2> /dev/null`, `2>/dev/nullx`, and every other redirection are reviewed. When in doubt the command is reviewed.

A `cd` segment is safe only when it provably stays in the workspace, so `cd packages/app && git status` runs without review. Like `git -C`, which is excluded, a `cd` elsewhere would let a safe `git` command run another repository's configuration, such as `core.fsmonitor`. The `cd` must have one literal operand (no options, `-`, `~`, or variable) naming an existing directory inside the workspace that is not a Sensitive Path, the same whether `..` is taken lexically or after symlinks, with no `.git` or `HEAD` (a possible bare repository) between it and the workspace root; while `CDPATH` is set, only an absolute operand qualifies. Each `cd` is judged from every directory the shell may be in: the working directory, and each earlier `cd` target, since a `cd` may fail. So `cd a && cd b` is reviewed unless `b` also qualifies from the working directory, and `cd a && cd ..` is reviewed because `..` from the working directory leaves the workspace. A `cd` in a pipeline is reviewed. A directory change that only an `allow` Command Rule permits (`cd`, `pushd`, `popd`, or `source`, `.`, and `eval`, which may change it) leaves the directory unknown: no later `cd` is then a Safe Command segment, and neither is a built-in `git` (one that an `allow` rule of yours covers stays your choice). What the shell inherits matters too. A `cd` is reviewed unless Pi runs bash or `sh` (`shellPath`) with no `shellCommandPrefix`, nothing can redefine `cd` (`BASH_ENV`, `ENV`, `BASHOPTS`, `SHELLOPTS`, or an exported `BASH_FUNC_*` function), and every `GIT_*` variable is unset or an absolute path, since a relative `GIT_DIR` is resolved against the directory `cd` enters. A built-in `git` is reviewed with or without a `cd` while `GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_CONFIG`, `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM`, `GIT_CONFIG_COUNT`, or `GIT_CONFIG_PARAMETERS` is set, any program an exported function replaces is reviewed, and while `PATH` has an empty or relative entry no command is a Safe Command, since a bare program name could then run a file the agent wrote. So is a `cd` in a call a `codemode` script issues, or beside another call of a parallel tool batch that does more than read (read-only built-in tools and built-in Safe Commands): Pi judges every call of such a batch before running them together, so that call could change the target first.

**Command Rules** (`commands`) map literal command prefixes to `allow`, `review`, or `deny`, checked against every segment by its leading words as the shell reads them (after any `NAME=value` assignments, with quotes, `$'\x72m'`-style escapes, and line continuations resolved); the longest matching prefix wins. Segments are split at `|`, `&&`, `||`, `;`, `&`, newlines, and subshell and substitution boundaries (`(`, `)`, backticks), skipping comments and here-document bodies. For `deny` and `review`, a rule also matches after leading wrappers that run the command after them (`time`, `env`, `nohup`, `exec`, `command`, `builtin`, `nice`, `sudo`, `doas`, `xargs`, with their options) or start one (`!`, `{`, `if`, `then`, `elif`, `else`, `while`, `until`, `do`), and on macOS and Windows the program name matches in any case. When a command holds syntax such a reader may misread (a here-document, comment, `$'…'` or `$"…"` string, line continuation, substitution, or an unterminated quote), `deny` rules are also matched against a quote-agnostic split of the whole command, which may deny a command that only mentions a denied one:

- `allow` makes a matching segment a Safe Command segment: `"git describe": "allow"` allows `git describe --tags`, but the rest of the segment must still be literal words.
- `review` sends the whole command to a Guardian Review even if it is otherwise a Safe Command; the Reviewed Call names the rule.
- `deny` blocks the whole command without a model call when any segment matches, even with `tools.bash: "allow"`.

A rule's prefix must be literal words starting with a bare program name; one such as `"./gradlew test"` could never match and is rejected as invalid settings. A rule matches words, not effects: `"git push --force": "deny"` does not match `git push origin main --force` or `git push -f`, so deny `git push` entirely if forced pushes must never run. And `deny` is not a sandbox: `bash -c "rm -rf x"`, `/bin/rm`, `$(echo rm)`, an alias, or a script do not match `rm`. Such commands are never Safe Commands, so they are reviewed, and the Reviewed Call lists your `deny` and `review` rules; the policy rates reaching a denied command's effect another way as `security_policy` risk. Avoid script runners (`npm test`, `pnpm lint`, `make`) as `allow` rules: see [Limitations](#limitations).

## Guardian Review

Each review is one stateless model completion without tools ([ADR-0001](docs/adr/0001-review-with-one-stateless-call.md)), plus an [Escalation Pass](#escalation-pass) when the first would be rejected ([ADR-0003](docs/adr/0003-rules-reasoning-blind-evidence-and-escalation.md)). With `classifierModel` set, a [classifier](#classifier-first-pass) makes that First Pass instead ([ADR-0004](docs/adr/0004-classifier-first-pass-escalates-on-rejection-probability.md)). A language model's request holds:

- **System prompt**: the built-in policy (evidence handling, User Authorization scoring, risk taxonomy, Pi tools), your Security Policy (`policy`), and the output contract.
- **One user message** of text blocks: context files, then evidence entries in conversation order, then the **Reviewed Call** — the tool, why it was reviewed (such as its Sensitive Path), the SHA-256 and full text of its exact arguments, the working directory, which agent issued it, for nested calls the issuing call's tool and arguments, and the other calls of its tool batch, which Pi may run before or alongside it. Each batch call's arguments are shortened beyond 2,000 characters, except its `path` and `command`, which are always shown whole. For a nested call, the batch is its issuing call's, without the issuing call itself; the script's other nested calls appear only in the issuing call's arguments. The batch calls are context, each reviewed on its own: the Guardian rates only the Reviewed Call's own effect, and another call matters only where the two interact. So the policy rates creating or replacing a link, or moving a file, onto a path another call of the batch writes as a `sensitive_path` risk, and so is creating a link whose target is a Sensitive Path or outside the workspace on its own, which also covers links a `codemode` script's nested calls create. Running code or configuration that another call of the batch writes, such as a `git` command in a directory where another call plants a repository's `config`, is rated `unreviewed_execution` when the evidence does not show that content in full.

The request is append-only: each review's blocks extend the previous review's, so provider prompt caches apply across reviews, even after the history outgrows the evidence budget (see below). Guardian never changes the Guarded Agent's system prompt, tools, or messages.

Pi runs a response's `tool_call` handlers one call at a time, even for parallel tool calls. Guardian therefore starts the reviews of a response's tool calls as soon as the response ends, at most four at once, and reuses each result when its call reaches `tool_call` with the same tool and arguments, the same Tool Policy and reason (which name any Sensitive Path and where it resolves now), the same settings, and the same Guardian model; otherwise it reviews the call again. So parallel calls are reviewed concurrently. When Pi runs a batch one call at a time (the `toolExecution` setting, or a tool in the batch with `executionMode: "sequential"`), each call's preflight follows the earlier calls' results, so only the first call is reviewed early. Guardian skips calls to unknown tools and calls whose arguments fail the tool's schema, which Pi never runs. A review started for a call that never arrives, or that was not reused, is recorded as `unused`.

Nested calls are different: a tool that issues calls concurrently, such as a `codemode` script's `Promise.all`, runs Guardian's `tool_call` handler for each at once, so their reviews run concurrently. Their **Allow once** dialogs are queued and shown one at a time.

### Evidence and trust

Evidence is **reasoning-blind** ([ADR-0003](docs/adr/0003-rules-reasoning-blind-evidence-and-escalation.md)): user messages, and the Guarded Agent's tool calls (tool names and arguments, in order, origin `agentToolCalls`) so the Guardian sees what the agent already did, such as the script it wrote before running it. The agent's text and reasoning, tool results, other extensions' custom messages, `!` command output, and compaction and branch summaries are left out: they cannot authorize a call and are where injected or mistaken justifications live. Guardian reads messages from the session branch's entries, not the model context, so compaction never drops a user message or tool call, and context edits do not change what the user typed. The response holding the Reviewed Call is left out of the evidence, since the Reviewed Call shows it with its batch.

**Trusted Evidence** can establish User Authorization: messages the user typed, context files, recorded **User Overrides**, and **Approved Delegations**. Guardian reads context files from Pi's resource loader (`getAgentsFiles()`), not from the system prompt, so a tool's prompt snippet cannot forge them. Pi loads `AGENTS.md`-style files from the working directory and its ancestors whether or not the project is trusted, so only the global file in Pi's agent directory and, in a trusted project, the others are Trusted Evidence; an untrusted project's context files are included as untrusted evidence.

Everything else is labeled **UNTRUSTED**: the agent's tool calls, user messages an extension sent (`sendUserMessage`), the body of a Skill expanded by `/skill:` (the text the user typed after it stays trusted), and in Child Agent and Advisor sessions every user message and parent Coordination Message that is not an Approved Delegation, since it comes from another agent. A Child Agent's or Advisor's reviews also include the **root user's** typed messages (origin `rootUser`) as Trusted Evidence, interleaved by time, while the root session runs Guardian in the same process. Each entry carries its message as JSON, so content cannot forge an evidence label.

An **Approved Delegation** is a Child Agent's task, or a parent's Coordination Message (`agent_message`) to it, that the parent session's Guardian reviewed and allowed while judging the user authorized it (User Authorization `medium` or `high`, and a Risk Category for any `high` or `critical` risk), or the parent's user allowed once. A delegation the Guardian allowed only because its risk was low, with `low` or `unknown` authorization, is not approved: it ran, but its text stays untrusted in the Child Agent. Authorization is thus established at the handoff: the parent's Guardian judges the actions the task asks for against the user's request, and the child's Guardian judges the child's calls against the task. Each review entry of a `subagent` or `agent_message` call records the SHA-256 of its `task` or `message` (`delegationSha256`) and, once the call ran, the canonical agent ID its result names (`delegationRecipient`); a session publishes the approved ones in-process under its root session ID and Minimal Subagents canonical agent ID (`root` for the root session). A Child Agent matches its own user message, or the task after Minimal Subagents' exact framing of inherited conversation for that agent and parent, against its parent's `subagent` delegations, and a Coordination Message from its direct parent against its parent's `agent_message` delegations: the text must match exactly, and the delegation must have reached this agent (its canonical agent ID, ignoring a legacy `root.` prefix). So a text approved for one agent or use cannot be replayed to another, for example through an `agent_message` an `allow` Tool Policy lets through. A match is Trusted Evidence with origin `approvedDelegation`, labeled as written by the delegating agent and approved by its Guardian with that review's risk and authorization. This works through nested delegation, since a Child Agent publishes its own approved delegations. A delegation an `allow` Tool Policy let through was never judged and stays untrusted; Advisor messages are never approved.

Guardian recognizes an extension-sent message from Pi's `input` event (`source: "extension"`): the user message whose text is exactly that input's, plus any image hints Pi appended, matched oldest first. It records a `pi-guardian-extension-message` session entry, so the label survives reloads. Not distinguishable, and therefore trusted like typed text: prompt templates expanded from `/name`, an extension message that another extension's `input` handler rewrote, and task messages from subagent systems other than Minimal Subagents.

The evidence budget (`evidenceBudgetTokens`) defaults to `auto`: a quarter of the Guardian model's context window, at most 32,000 tokens. Pi's chars/4 estimate undercounts Guardian's JSON-heavy requests (about 1.3× on Claude Haiku and 1.7× on Claude Opus), so Guardian scales it by a per-model factor: 1.5 until the model's provider reports usage, then the reported prompt tokens (input plus cache reads and writes) over the estimate, rounded up to a quarter and changed only by a clear margin so it stays stable. Each review entry records its estimate and the reported tokens, and the factor is derived from the selected branch's entries, so a reload or branch switch finds the same factor.

All Trusted Evidence is always kept. The rest is a window of every entry from an anchor onward, so successive reviews share their prefix. When the evidence outgrows the budget, the anchor jumps forward past at least half a budget of the oldest untrusted entries, replaced by an omission note; the provider's cache breaks only at those jumps, at most once per half-budget of growth. The anchor is a pure function of the history, so a reload or branch switch finds the same window. Each untrusted entry is shortened, with a marker, only when it alone exceeds a quarter of the evidence budget, such as a very large `write`; the policy treats content shortened from a file that is later executed as `unreviewed_execution`. Trusted Evidence is shortened, every entry with the same cap, only when it alone exceeds the budget.

The Reviewed Call is never shortened, since a cut could hide the harmful part of a call. When it does not fit the Guardian model's context window beside the policy and room for the reply, the review is a Review Failure, and the evidence budget shrinks to what is left beside it.

### Decision Table

The model returns `{"risk_level", "user_authorization", "risk_category", "rationale"}` (fenced JSON is tolerated; `null` category or rationale counts as absent; a reply with two differing assessments is malformed).

`high` and `critical` risk require a **Risk Category**, the concrete reason the call is dangerous: `data_egress`, `credential_access`, `destruction`, `persistence`, `sensitive_path`, `safety_weakening`, `remote_code`, `unreviewed_execution` (running code the agent wrote or changed this session whose content the evidence does not fully show), or `security_policy` (violating your Security Policy, or reaching a `deny` Command Rule's effect another way), offered only when a Security Policy or `deny` Command Rule is configured. Categories are matched case-insensitively, with hyphens or spaces read as underscores. The policy starts from routine development work and lists what is never a reason for `high` on its own: the size or complexity of a change, a workspace file being important or security-relevant without being a Sensitive Path, reading, searching, or listing anything (including `node_modules` and reference checkouts), the project's build, test, lint, and typecheck commands, local reversible git operations, missing specific authorization, and the call coming from a Child Agent or Advisor. A `high` or `critical` assessment without a valid category gets the corrective retry (below), which restates the categories; only if the retry still names none is it decided as `medium`, and its audit entry is marked `downgraded` and always shown. A malformed retry is a Review Failure (in an Escalation Pass, the first pass's Rejection stands), never the uncategorized assessment decided as `medium`.

Unless `verbose` is on, the output contract asks for the rationale only at `high` or `critical` risk, the only levels the Decision Table can reject, which saves output tokens and latency; a Rejection whose assessment omits it uses the fixed reason "The Guardian gave no specific rationale." The contract is part of the system prompt, so it changes, and the cache restarts, only when `verbose` does. The Outcome is fixed:

| Risk Level | `unknown` | `low`    | `medium` | `high`   |
| ---------- | --------- | -------- | -------- | -------- |
| `low`      | allowed   | allowed  | allowed  | allowed  |
| `medium`   | allowed   | allowed  | allowed  | allowed  |
| `high`     | rejected  | rejected | allowed  | allowed  |
| `critical` | rejected  | rejected | rejected | rejected |

### Escalation Pass

A small model answering at once is fast but blunt. When the first pass's assessment would be rejected, Guardian runs an **Escalation Pass** before the Rejection stands: the same system prompt and user message plus a final instruction to reason step by step and give a rationale, without the first assessment. Its request extends the first pass's, so with the same model the system prompt is a prompt-cache hit; the user message is too only when the thinking settings also match, since a provider such as Anthropic invalidates cached messages when thinking changes, as it does with the default `escalationThinkingLevel` and `thinkingLevel: "off"`. The Escalation Pass uses `escalationModel` (default: the Guardian model) at `escalationThinkingLevel` (default `low`, or `thinkingLevel` if higher), gets its own `reviewTimeoutMs`, and its own corrective retry. Its assessment decides the Outcome. If it fails (no model, a provider error, a timeout, malformed output after its retry, or a request too large for the escalation model), the first pass's Rejection stands; an escalation never allows a call by failing. The first pass keeps its calibration: it is not told to block when unsure.

The review's audit entry holds the deciding assessment, under `escalation` its `trigger` (`rejected`, or for a classifier's First Pass `uncertain`, `uncategorized`, or `failed`), the First Pass's assessment (`null` when it failed), and the Escalation Pass's model, result, failure, duration, usage, and cost, and the summed duration, usage, and cost. Escalations that overturned or confirmed a Rejection, failed, or followed a failed classifier are always shown in the transcript, marked `escalated` or `escalation failed, first pass stands`; an escalation that resolved a classifier's doubt by allowing the call shows only with `verbose`.

### Classifier First Pass

A classifier model answers typed questions with calibrated probabilities instead of writing text, so it is much faster and cheaper than a language model but gives no rationale. Set `classifierModel` to one of Pi's classifier models (`provider/id`, as listed by `/guardian`'s picker; for example TypeSafe's `typesafe/jev-latest`, with `TYPESAFE_API_KEY` or `/login`) and it makes each review's First Pass ([ADR-0004](docs/adr/0004-classifier-first-pass-escalates-on-rejection-probability.md)). `off` turns off an inherited classifier.

One request asks three `choice` questions, each carrying the parts of the built-in policy it needs: the Risk Level, the User Authorization, and the Risk Category (or `none`). Its state is your Security Policy, the evidence, sized to the classifier's context window by the same `evidenceBudgetTokens` rule, and the Reviewed Call. The Decision Table decides the most likely answers. The First Pass escalates to the [Escalation Pass](#escalation-pass), whose language model sees the usual request (system prompt, evidence sized to that model, and Reviewed Call) and never the classifier's answers, when:

- its Outcome would be a Rejection (`rejected`);
- its **Rejection Probability**, P(`critical`) + P(`high`) × P(`unknown` or `low` User Authorization), reaches `escalationThreshold` (default `0.2`), so doubt between two allowed Risk Levels does not count (`uncertain`);
- it rates `high` or `critical` risk with category `none`, which a language model's First Pass would retry and then decide as `medium` (`uncategorized`);
- it fails: no such classifier or no credentials, a call too large for it, a provider error, an invalid answer, or no answer within a fixed 10 s (`failed`).

The Escalation Pass uses `escalationModel`, else `model`, else the session's model. Its assessment decides. If it fails, a would-be Rejection stands, with the fixed reason "The Guardian gave no specific rationale."; after any other trigger the review is a Review Failure. An escalation never allows a call by failing. The audit entry's `model` names the classifier, and `classification` holds each question's probabilities, the Rejection Probability, the threshold, and any classifier failure.

### Rejection

A Rejection blocks the call and tells the agent:

```text
This action was rejected due to unacceptable risk.
Risk: high (destruction). Authorization: low.
Reason: <rationale>
Do not attempt to achieve the same outcome through a workaround, indirect execution, or variations of this call, and do not retry it. Explain the risk to the user and ask whether they want to proceed; continue only with a materially safer alternative or after the user explicitly approves this action.
```

The user sees a warning with the tool, risk, Risk Category, and rationale. With `onDeny: "ask"` and an interactive UI, a dialog offers **Allow once**: a User Override. A call too long to show in the dialog (over 2,000 characters) offers **View full call**, which opens the whole call read-only in Pi's editor; **Allow once** appears only after that. Otherwise the user can authorize the action in conversation, which the next review weighs as Trusted Evidence.

**Rejection Streak**: after `maxConsecutiveRejections` (default 3; 0 disables) consecutive blocked Reviewed Calls in one request, Rejections and blocked Review Failures alike, Guardian ends the turn: until the next prompt it blocks every call, including calls that would be allowed, and asks Pi to end the turn. Any allowed Reviewed Call that actually runs, including a User Override, resets the streak before its limit, and so does every message the user types: a new prompt, and also a steering or follow-up message, which Pi delivers within the running request and which lifts the block once the limit was reached. In a Child Agent, a Coordination Message from its direct parent does the same, since it starts the child's next request. A call Guardian allowed but another extension then blocked does not. Pi ends the turn only when every call of a tool batch asks to, and a call of the batch that already ran cannot ask afterwards, so when the limit is reached after such a call, Pi requests one more response, whose calls Guardian all blocks to end the turn.

### Review Failure

No model resolved, no credentials, a provider error, a timeout (`reviewTimeoutMs`), malformed output twice in a row, a Reviewed Call too large to review in full, or unreadable Guardian settings never allow a call. With an interactive UI, a dialog offers **Allow once** (a User Override) or **Block**, after **View full call** for a long call; without one, the call is blocked with the reason and a pointer to the troubleshooting Skill. Aborting the agent's turn aborts its reviews; an aborted review blocks its call with an "aborted" reason and is not a Review Failure.

A reply without exactly one valid assessment gets one corrective retry within the same deadline: the first request plus the bad reply and a user message restating the JSON contract, so the first request's cached prefix is unchanged. Pi's provider-neutral API has no JSON mode or forced tool call, so the contract is enforced by parsing. A retried review is marked `retried` in its audit entry.

### Audit

Every Guardian Review appends a `pi-guardian-review` session entry, which never reaches the model: tool, call ID, parent call ID, arguments (bounded) and their full SHA-256, Risk Level as stated, Risk Category, whether an uncategorized `high` or `critical` was `downgraded`, User Authorization, `result` (the Outcome `allowed` or `rejected`, or `failed`, `aborted`, or `unused`), rationale, failure, User Override, whether an allowed call actually ran, the first pass's model, duration, token usage and cost summed over retries and an Escalation Pass, the Escalation Pass itself (`escalation`), a classifier First Pass's answers (`classification`), the calibration sample (estimated and reported prompt tokens of the first pass), whether the review was retried, argument drift, and for `subagent` and `agent_message` calls the delegated text's SHA-256 (`delegationSha256`). `/guardian status` derives its totals from the selected branch's entries.

The transcript shows only the reviews that need attention: Rejections, Review Failures, aborted reviews, User Overrides, argument drift, downgraded assessments, and escalated reviews. Allowed and unused reviews are still recorded and counted, but render nothing unless `verbose` is on. Guardian shows no notice for allowed calls; while a review runs, the footer shows `● guardian reviewing <tool>`. Review and status entries use Pi's custom-message box with a bold `Guardian` label, a Status Mark per result (`✓` allowed, `✗` rejected, `!` failed, `■` aborted, `○` unused) and a ten-line Collapsed View with Pi's expand hint. Warnings and errors read `Guardian: ...`.

User Overrides return to later reviews as Trusted Evidence in structured form. The user's decision is trusted but the arguments were written by the agent, so they are a marked field, and the Guardian's rationale is left out:

```json
{
  "userOverride": {
    "decision": "The user interactively allowed one call after a Rejection.",
    "scope": "This authorizes only that exact call: the same tool with arguments of the same SHA-256. …",
    "tool": "bash",
    "argumentsSha256": "…",
    "agentAuthoredArguments": "{\"command\":\"rm -rf dist\"}",
    "agentAuthoredArgumentsShortened": false
  }
}
```

## Commands

```text
/guardian
/guardian status
/guardian on|off [--global|--project]
/guardian tool <name> <allow|review|deny|default|inherit> [--global|--project]
/guardian command <prefix> <allow|review|deny|default|inherit> [--global|--project]
/guardian policy [--global|--project]
/guardian inherit [key] [--global|--project]
/guardian set <key> <JSON> [--global|--project]
```

Without a flag, changes go to the session. In the interactive TUI, `/guardian` opens a settings menu like `/advisor`'s: a Scope row (session, trusted project, global), cycling rows for `enabled`, `thinkingLevel`, `escalationThinkingLevel`, `onDeny`, and `verbose` that show the selected scope's own value or what it inherits, model pickers for `model` and `escalationModel`, a classifier picker for `classifierModel` (with `off`), a per-tool Tool Policy list, the Security Policy in Pi's editor, and typed values for the rest; Command Rules are typed as comma-separated `prefix=value` pairs (`git describe=allow, rm=deny`; `default` resets an inherited entry), a JSON object, or `none`. `/guardian command git push deny` changes one Command Rule; its prefix is every word between `command` and the value. Closing it records one status entry listing the changes it applied. Elsewhere `/guardian` records a status entry.

`/guardian status` records the effective settings with their sources, the classifier and its threshold when set, the escalation model and thinking level, whether the session follows a root session, review counts (allowed, rejected, failed, aborted, overrides, escalated by trigger, argument drift), total review cost, and the last failure. The footer shows `● guardian on` while idle, `● guardian reviewing <tool>` during reviews, and nothing while disabled.

## Settings

Settings live under `guardian` in Pi's global and trusted-project `settings.json`, plus session overrides. Precedence is default < global < trusted project < session; a trusted project may weaken Guardian ([ADR-0002](docs/adr/0002-trusted-projects-may-weaken-guardian.md)), while an untrusted project's settings are ignored.

| Key                        | Default   | Meaning                                                                                              |
| -------------------------- | --------- | ---------------------------------------------------------------------------------------------------- |
| `enabled`                  | `false`   | Gate tool calls. While disabled Guardian does nothing, including `deny` Tool Policies.               |
| `model`                    | session   | Guardian model as `provider/id`; absent follows the session's current model. Prefer a small one.     |
| `thinkingLevel`            | `"low"`   | `off` … `max`, clamped to the model.                                                                 |
| `classifierModel`          | none      | Classifier model of the [First Pass](#classifier-first-pass) as `provider/id`; `off` turns it off.   |
| `escalationThreshold`      | `0.2`     | Rejection Probability, from 0 to 1, at which a classifier's First Pass escalates.                    |
| `escalationModel`          | Guardian  | Escalation Pass model as `provider/id`; absent uses the Guardian model, or the session's.            |
| `escalationThinkingLevel`  | `"low"`   | Escalation Pass thinking level; absent is `low`, or `thinkingLevel` if that is higher.               |
| `tools`                    | `{}`      | Tool Policies by tool name: `allow`, `review`, `deny`, or `null` to reset an inherited entry.        |
| `commands`                 | `{}`      | Command Rules by literal command prefix: `allow`, `review`, `deny`, or `null` to reset an entry.     |
| `policy`                   | `""`      | Security Policy: trusted destinations, forbidden actions, and other rules added to the built-in one. |
| `reviewTimeoutMs`          | `60000`   | Deadline for each review; a timeout is a Review Failure.                                             |
| `evidenceBudgetTokens`     | `"auto"`  | Positive integer or `auto`.                                                                          |
| `onDeny`                   | `"block"` | `block`, or `ask` to offer Allow once on a Rejection in interactive sessions.                        |
| `maxConsecutiveRejections` | `3`       | Rejection Streak that ends the turn; `0` never ends it.                                              |
| `verbose`                  | `false`   | Ask for a rationale on every review and show allowed reviews in the transcript, for debugging.       |

`tools` and `commands` merge entry by entry across scopes: a higher scope adds or replaces entries, and `null` removes a lower scope's entry so the built-in default applies again. `set tools <JSON>` and `set commands <JSON>` replace that scope's whole map; `tool <name> <value>` and `command <prefix> <value>` change one entry (`default` writes `null`, `inherit` removes the scope's entry). A configured Tool Policy overrides the built-in default, so `{"edit": "allow"}` also allows edits to Sensitive Paths; a `deny` Command Rule still blocks matching `bash` commands under `{"bash": "allow"}`. `review` and `allow` Command Rules, however, refine only the built-in `bash` default: under `{"bash": "allow"}` every command that no `deny` rule matches runs unreviewed, including those a `review` rule names, and under `{"bash": "review"}` every command is reviewed.

The Security Policy can name trusted destinations and forbid actions, and a call that violates it is `security_policy` risk, but the Guardian judges it. Put hard limits that must not depend on a model in `deny` Command Rules or `deny` Tool Policies.

```json
{
  "guardian": {
    "enabled": true,
    "model": "anthropic/claude-haiku-4-5",
    "thinkingLevel": "off",
    "tools": { "mcp__github__create_issue": "allow", "terminal_send": "deny" },
    "commands": { "tree": "allow", "git describe": "allow", "git push": "deny" },
    "policy": "Pushing to github.com/acme/* is trusted. Never touch the production database.",
    "onDeny": "ask"
  }
}
```

## Child Agents and Advisors

Guardian loads in every session that loads it, including Minimal Subagents Child Agent sessions (print mode, no UI) and Advisor sessions. A Child Agent (detected by Minimal Subagents' `minimal-subagents.identity` entry) or an Advisor (pi-advisor's `pi-advisor-role` entry) follows its root session's effective settings live while that root runs Guardian in the same process; otherwise it falls back to its own global and project settings. Each such session republishes its root, so an Advisor observing a Child Agent follows the real root and receives the root user's messages. Once a session has followed its root, it keeps the root's last settings and typed messages after the root leaves (`/new`, `/resume`, or shutdown) rather than falling back to its own, possibly laxer, settings. Its task and other user messages come from another agent, so they are untrusted unless they are an [Approved Delegation](#evidence-and-trust) of its direct parent, and without UI its Review Failures and Rejections block. Settings changes from inside such a session are refused; change them in the root session.

Only these two kinds of delegated session are detected. A child session of any other subagent system is treated as a main session: its task message, sent by another agent, appears user-typed and counts as Trusted Evidence.

## Limitations

- **Argument drift**: Guardian reviews the arguments its `tool_call` handler sees. An extension loaded after Guardian can still change them. Pi emits `tool_execution_start` before `tool_call` handlers run, so Guardian compares the reviewed arguments with the `tool_result` event's arguments instead and warns after the call has run, marking the review entry with `argumentDrift`. Install Guardian last. Likewise, Guardian recognizes a user message an extension sent (`sendUserMessage`) by its text as Guardian's `input` handler saw it: an extension loaded after Guardian that rewrites that text in its own `input` handler makes the message look typed by the user, and so trusted.
- A Child Agent or Advisor sees the root user's typed messages only while the root session runs Guardian in the same process; otherwise its evidence holds only its own conversation, none of it trusted.
- Reviews cannot inspect files or run read-only checks (ADR-0001), so the policy leans conservative when evidence is missing.
- `git` read-only subcommands still honor repository configuration such as `core.fsmonitor` or `diff.external`; edits to `.git` are Sensitive Paths and therefore reviewed. A sibling write's content beyond 2,000 characters is shortened in a review, so a planted configuration may be only partly shown; the policy then rates running it `unreviewed_execution`. Git variables are judged from this process's environment; a variable a command sets for itself (`GIT_DIR=x git status`) already keeps it from being a Safe Command.
- Annotations and Safe Commands are trusted as declared; a tool that lies about `readOnlyHint` or `openWorldHint` runs without review unless you configure it.
- **Exfiltration through reads**: a read can still send data out when it reaches the network. `web_fetch` is therefore reviewed by default, since its URL can carry workspace contents to any host, and so is any tool annotated both read-only and open-world. `web_search` stays allowed: its query goes only to the configured search provider. Allow `web_fetch` with `tools.web_fetch: "allow"` only if you accept that risk.
- **Command Rules are not a sandbox**: a rule matches a segment by its literal leading words, so a wrapper (`env`, `sudo`, `bash -c`, `xargs`), a path, an alias, a substitution, or a script can run a denied command; Guardian reviews such commands and tells the Guardian the rules, but only the Guardian's judgment stands between them and execution.
- **Approved Delegations** are published in-process: a Child Agent whose parent session does not run Guardian in the same process, or reloaded before its parent republished, keeps its task untrusted. A task is matched exactly, so one that Minimal Subagents or another extension rewrites is untrusted.
- **Script runners run unreviewed code**: a Safe Command such as `npm test`, `pnpm lint`, or `make` executes whatever the workspace's `package.json` scripts, test files, and tool configuration say, and ordinary workspace edits to those files are not reviewed. Do not add script runners as `allow` Command Rules unless you accept that an agent can run arbitrary code through them. Likewise, extensions that act after edits, such as pi-formatter running formatters with workspace configuration, can execute code that Guardian never reviews.
- An ordinary edit runs without review even when another call of its tool batch could replace its target with a link first; the reviewed call sees the edit as batch context and the policy rates such links `sensitive_path`, but a link created by an allowed call, a Safe Command, or a concurrent process is not caught. Likewise a `cd` Safe Command segment judges its target when the call is prepared; a background process the agent started earlier could still change it. Guardian judges each call's path at its own preflight, and concurrent nested calls of a `codemode` script are judged one by one.
- Hard links are detected only on existing files; Guardian cannot see a link a concurrent process creates after its check.
- Pi dispatches extension commands before its `input` event and does not tell a command who sent it, so an extension that sends `/guardian …` through `sendUserMessage` with `expandPromptTemplates: true` can change session settings. Installed extensions are trusted code; Guardian cannot refuse such a command.
- Extensions inside the workspace are not Sensitive Paths, so an agent can edit them; the change runs only after the user reloads Pi.

## Attribution

Guardian's built-in policy is adapted from the Guardian prompts of [OpenAI Codex](https://github.com/openai/codex) (`codex-rs/prompts/templates/guardian/`), Copyright 2025 OpenAI, licensed under the [Apache License, Version 2.0](http://www.apache.org/licenses/LICENSE-2.0). The adaptation (rewritten for Pi's tools, Trusted Evidence, a single stateless review, and an external Decision Table) is in [`src/guardian-prompt.ts`](src/guardian-prompt.ts). The Rejection wording follows Codex's.

## Troubleshooting

Run `/skill:pi-guardian`, or see [`skills/pi-guardian/SKILL.md`](skills/pi-guardian/SKILL.md).
