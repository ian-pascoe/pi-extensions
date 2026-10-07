# Pi Guardian

`@ian-pascoe/pi-guardian` gates a Pi agent's tool calls before they run. Routine calls run at once; risky ones go to a separate reviewer model, the Guardian, which judges the call's risk against the user's authorization. A fixed Decision Table turns that judgment into an allowed call or a binding Rejection.

Requires Node `>=22.19.0` and Pi `>=0.99.0`.

> **Guardian is a safety net, not a sandbox.** An allowed call runs with your full privileges, a reviewer model can be wrong or manipulated, and other extensions can still act on their own. Keep backups and review what agents do.

## Install

```bash
pi install npm:@ian-pascoe/pi-guardian
# or from this checkout
pi -e ./packages/pi-guardian/src/index.ts
```

**Install Guardian last.** Pi runs `tool_call` handlers in extension load order, and an extension loaded after Guardian can rewrite a call's arguments after Guardian reviewed them. Guardian detects this after the call runs (see [Limitations](#limitations)).

Guardian is **enabled by default** and reviews with the session's current model unless `model` is set. Without a usable model, every call that needs review is a Review Failure.

## How a call is judged

Every `tool_call`, including calls a tool issues itself (such as a `codemode` script's calls, which carry `parentToolCallId`), resolves to one Tool Policy:

1. the configured `tools.<name>` setting, if any;
2. else the built-in default:
   - `allow`: `read`, `grep`, `find`, `ls`, `codemode`, `tool_search`, `todo`, `web_search`, `web_fetch`;
   - `edit` and `write`: `allow`, unless the target is a **Sensitive Path** or the call shares its assistant message's tool batch with a call that is not allowed without review (Pi may run them in parallel, and that call could replace the target with a link first); either is reviewed;
   - `bash`: `allow` only for a **Safe Command**, otherwise reviewed;
   - `terminal_start`, `terminal_send`, and `powershell`: reviewed;
3. else the tool's `readOnlyHint: true` annotation (as reported by `pi.getAllTools()`) allows it;
4. else the call is reviewed.

`deny` blocks the call without a model call. `review` sends it to a Guardian Review. A nested call is judged by its own Tool Policy; the issuing call is shown to the Guardian as context only.

While Guardian's settings cannot be read (invalid `guardian` settings or an unreadable session), every call except the built-in `read`, `grep`, `find`, and `ls` is a Review Failure: the unreadable settings may have held `deny` or `review` rules, so neither they nor the built-in defaults apply. The footer shows `guardian: settings error`, and the error is reported when the session starts and in each blocked call's reason.

**Sensitive Paths** are judged after resolving `~`, `..`, `@`, `file://`, and symlinks (including dangling ones), on both the lexical and the resolved path:

- anything outside the working directory, and **every** path when the working directory is the home directory, an ancestor of it, or `/`;
- persistence and credential locations under the home directory wherever the workspace is: shell startup files (`.bashrc`, `.bash_profile`, `.profile`, `.zshrc`, `.zprofile`, `.zshenv`, and similar), `.ssh`, `.gnupg`, `.aws`, `.azure`, `.config` (including fish and systemd user units), `.local/bin`, `Library/LaunchAgents`, `.gitconfig`, `.git-credentials`, `.npmrc`, `.yarnrc`, `.pypirc`, `.netrc`, `.docker`, and `.kube`; system crontabs are outside any workspace;
- inside the workspace, any case: `.git`, `.pi`, `.agents`, `.env*` (including `.envrc`), `.husky`, `.github/workflows`, `.vscode`, and context files named `AGENTS.md`, `AGENTS.override.md`, or `CLAUDE.md` at any depth;
- Pi's agent directory (`getAgentDir()`), the session directory, and every resource Pi loaded into the session: context files, Skills (their whole directory), prompt templates, system prompt files, and extensions;
- an existing file with more than one hard link, since editing it in place changes the other paths too;
- on Windows, a path with backslashes or a drive letter, which Guardian does not judge.

Pi configuration, context files, and loaded resources are sensitive because changing them can weaken Guardian or rewrite the instructions it trusts.

A **Safe Command** is one simple command of literal words: no pipes, redirection, `;`, `&&`, `||`, `&`, subshells, grouping, command or process substitution, backticks, newlines or other control characters, variable, tilde, brace or history expansion, globbing, comments, escapes, or environment assignments, and a bare program name (no path). The built-in programs are `ls`, `pwd`, `cat`, `head`, `tail`, `wc`, `echo`, `stat`, `du`, `df`, `basename`, `dirname`, `realpath`, `which`, `whoami`, `uname`, `grep`, `rg` (without `--pre`, `--pre-glob`, or `--hostname-bin`), `find` (without `-exec`, `-execdir`, `-ok`, `-okdir`, `-delete`, `-fprint`, `-fprint0`, `-fprintf`, or `-fls`), and `git status`, `git log`, `git diff`, `git show` (without `--output`, `--ext-diff`, or `--textconv`), `git branch` (listing flags only), and `git rev-parse`, with no git options before the subcommand. When in doubt the command is reviewed. `safeCommands` adds literal prefixes: `"npm test"` allows `npm test` and `npm test -- --run`, but the rest of the command must still be literal words. An entry must itself be literal words starting with a bare program name; one such as `"./gradlew test"` could never match and is rejected as invalid settings. Avoid script runners (`npm test`, `pnpm lint`, `make`) in `safeCommands`: see [Limitations](#limitations).

## Guardian Review

Each review is one stateless model completion without tools ([ADR-0001](docs/adr/0001-review-with-one-stateless-call.md)):

- **System prompt**: the built-in policy (evidence handling, User Authorization scoring, risk taxonomy, Pi tools), your Security Policy (`policy`), and the output contract.
- **One user message** of text blocks: context files, then evidence entries in conversation order, then the **Reviewed Call** — the tool, why it was reviewed (such as its Sensitive Path), the SHA-256 and full text of its exact arguments, the working directory, which agent issued it, and for nested calls the issuing call's tool and arguments.

The request is append-only: within the evidence budget, each review's blocks extend the previous review's, so provider prompt caches apply across reviews. Guardian never changes the Guarded Agent's system prompt, tools, or messages.

Pi runs a response's `tool_call` handlers one call at a time, even for parallel tool calls. Guardian therefore starts the reviews of a response's tool calls as soon as the response ends, at most four at once, and reuses each result when its call reaches `tool_call` with the same tool and arguments, so parallel calls are reviewed concurrently. It skips calls to unknown tools and calls whose arguments fail the tool's schema, which Pi never runs. A review started for a call that never arrives, or whose arguments changed before Guardian saw them, is recorded as `unused`.

Nested calls are different: a tool that issues calls concurrently, such as a `codemode` script's `Promise.all`, runs Guardian's `tool_call` handler for each at once, so their reviews run concurrently. Their **Allow once** dialogs are queued and shown one at a time.

### Evidence and trust

**Trusted Evidence** can establish User Authorization: messages the user typed, context files, and recorded **User Overrides**. Guardian reads context files from Pi's resource loader (`getAgentsFiles()`), not from the system prompt, so a tool's prompt snippet cannot forge them. Pi loads `AGENTS.md`-style files from the working directory and its ancestors whether or not the project is trusted, so only the global file in Pi's agent directory and, in a trusted project, the others are Trusted Evidence; an untrusted project's context files are included as untrusted evidence.

Everything else is labeled **UNTRUSTED**: tool results, assistant text and reasoning, extension and summary messages, user messages an extension sent (`sendUserMessage`), the body of a Skill expanded by `/skill:` (the text the user typed after it stays trusted), and in Child Agent and Advisor sessions every user message, since it comes from another agent. Each entry carries its message as JSON, so content cannot forge an evidence label.

Guardian recognizes an extension-sent message from Pi's `input` event (`source: "extension"`) and records a `pi-guardian-extension-message` session entry, so the label survives reloads. Not distinguishable, and therefore trusted like typed text: prompt templates expanded from `/name`, an extension message that another extension's `input` handler rewrote, and task messages from subagent systems other than Minimal Subagents.

The evidence budget (`evidenceBudgetTokens`, by Pi's chars/4 estimate) defaults to `auto`: a quarter of the Guardian model's context window, at most 32,000 tokens. All Trusted Evidence is always kept, shortened with a marker if it alone exceeds the budget; the rest is the newest untrusted entries that fit. Each untrusted text is capped near 2,000 tokens with a marker.

The Reviewed Call is never shortened, since a cut could hide the harmful part of a call. When it does not fit the Guardian model's context window beside the policy and room for the reply, the review is a Review Failure, and the evidence budget shrinks to what is left beside it.

### Decision Table

The model returns `{"risk_level", "user_authorization", "rationale"}` (fenced JSON is tolerated; a reply with two differing assessments is malformed). The Outcome is fixed:

| Risk Level | `unknown` | `low`    | `medium` | `high`   |
| ---------- | --------- | -------- | -------- | -------- |
| `low`      | allowed   | allowed  | allowed  | allowed  |
| `medium`   | allowed   | allowed  | allowed  | allowed  |
| `high`     | rejected  | rejected | allowed  | allowed  |
| `critical` | rejected  | rejected | rejected | rejected |

### Rejection

A Rejection blocks the call and tells the agent:

```text
This action was rejected due to unacceptable risk.
Risk: high. Authorization: low.
Reason: <rationale>
Do not attempt to achieve the same outcome through a workaround, indirect execution, or variations of this call, and do not retry it. Explain the risk to the user and ask whether they want to proceed; continue only with a materially safer alternative or after the user explicitly approves this action.
```

The user sees a warning with the tool, risk, and rationale. With `onDeny: "ask"` and an interactive UI, a dialog offers **Allow once**: a User Override. A call too long to show in the dialog (over 2,000 characters) offers **View full call**, which opens the whole call read-only in Pi's editor; **Allow once** appears only after that. Otherwise the user can authorize the action in conversation, which the next review weighs as Trusted Evidence.

**Rejection Streak**: after `maxConsecutiveRejections` (default 3; 0 disables) consecutive blocked Reviewed Calls in one request, the blocking result also asks Pi to end the turn. Blocked Review Failures count toward the streak too, so a broken Guardian cannot keep a headless agent retrying. Any allowed Reviewed Call that actually runs, including a User Override, resets it, and so does each new prompt; a call Guardian allowed but another extension then blocked does not. Pi ends the turn only when every call in the tool batch asked to stop.

### Review Failure

No model resolved, no credentials, a provider error, a timeout (`reviewTimeoutMs`), malformed output, a Reviewed Call too large to review in full, or unreadable Guardian settings never allow a call. With an interactive UI, a dialog offers **Allow once** (a User Override) or **Block**, after **View full call** for a long call; without one, the call is blocked with the reason and a pointer to the troubleshooting Skill. Aborting the agent's turn aborts its reviews; an aborted review blocks its call with an "aborted" reason and is not a Review Failure.

### Audit

Every Guardian Review appends a `pi-guardian-review` session entry, which never reaches the model: tool, call ID, parent call ID, arguments (bounded) and their full SHA-256, Risk Level, User Authorization, outcome, rationale, failure, User Override, whether an allowed call actually ran, model, duration, token usage, cost, and argument drift. `/guardian status` derives its totals from the selected branch's entries.

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
/guardian policy [--global|--project]
/guardian inherit [key] [--global|--project]
/guardian set <key> <JSON> [--global|--project]
```

Without a flag, changes go to the session. In the interactive TUI, `/guardian` opens a settings menu like `/advisor`'s: a Scope row (session, trusted project, global), cycling rows for `enabled`, `thinkingLevel`, and `onDeny` that show the selected scope's own value or what it inherits, a model picker, a per-tool Tool Policy list, the Security Policy in Pi's editor, and typed values for the rest. Closing it records one status entry listing the changes it applied. Elsewhere `/guardian` records a status entry.

`/guardian status` records the effective settings with their sources, whether the session follows a root session, review counts (allowed, rejected, failed, aborted, overrides, argument drift), total review cost, and the last failure. The footer shows `guardian` while idle, `guardian: reviewing <tool>` during reviews, and nothing while disabled.

## Settings

Settings live under `guardian` in Pi's global and trusted-project `settings.json`, plus session overrides. Precedence is default < global < trusted project < session; a trusted project may weaken Guardian ([ADR-0002](docs/adr/0002-trusted-projects-may-weaken-guardian.md)), while an untrusted project's settings are ignored.

| Key                        | Default   | Meaning                                                                                              |
| -------------------------- | --------- | ---------------------------------------------------------------------------------------------------- |
| `enabled`                  | `true`    | Gate tool calls. While disabled Guardian does nothing, including `deny` Tool Policies.               |
| `model`                    | session   | Guardian model as `provider/id`; absent follows the session's current model.                         |
| `thinkingLevel`            | `"low"`   | `off` … `max`, clamped to the model.                                                                 |
| `tools`                    | `{}`      | Tool Policies by tool name: `allow`, `review`, `deny`, or `null` to reset an inherited entry.        |
| `safeCommands`             | `[]`      | Extra Safe Command prefixes; merged across scopes as a union.                                        |
| `policy`                   | `""`      | Security Policy: trusted destinations, forbidden actions, and other rules added to the built-in one. |
| `reviewTimeoutMs`          | `60000`   | Deadline for each review; a timeout is a Review Failure.                                             |
| `evidenceBudgetTokens`     | `"auto"`  | Positive integer or `auto`.                                                                          |
| `onDeny`                   | `"block"` | `block`, or `ask` to offer Allow once on a Rejection in interactive sessions.                        |
| `maxConsecutiveRejections` | `3`       | Rejection Streak that ends the turn; `0` never ends it.                                              |

`tools` merges entry by entry across scopes: a higher scope adds or replaces entries, and `null` removes a lower scope's entry so the built-in default applies again. `set tools <JSON>` replaces that scope's whole map; `tool <name> <value>` changes one entry (`default` writes `null`, `inherit` removes the scope's entry). A configured Tool Policy overrides the built-in default, so `{"edit": "allow"}` also allows edits to Sensitive Paths.

```json
{
  "guardian": {
    "model": "anthropic/claude-haiku-4-5",
    "tools": { "mcp__github__create_issue": "allow", "terminal_send": "deny" },
    "safeCommands": ["tree", "file"],
    "policy": "Pushing to github.com/acme/* is trusted. Never touch the production database.",
    "onDeny": "ask"
  }
}
```

## Child Agents and Advisors

Guardian loads in every session that loads it, including Minimal Subagents Child Agent sessions (print mode, no UI) and Advisor sessions. A Child Agent (detected by Minimal Subagents' `minimal-subagents.identity` entry) or an Advisor (pi-advisor's `pi-advisor-role` entry) follows its root session's effective settings live while that root runs Guardian in the same process; otherwise it falls back to its own global and project settings. Its task and other user messages come from another agent, so they are untrusted, and without UI its Review Failures and Rejections block. Settings changes from inside such a session are refused; change them in the root session.

Only these two kinds of delegated session are detected. A child session of any other subagent system is treated as a main session: its task message, sent by another agent, appears user-typed and counts as Trusted Evidence.

## Limitations

- **Argument drift**: Guardian reviews the arguments its `tool_call` handler sees. An extension loaded after Guardian can still change them. Pi emits `tool_execution_start` before `tool_call` handlers run, so Guardian compares the reviewed arguments with the `tool_result` event's arguments instead and warns after the call has run, marking the review entry with `argumentDrift`. Install Guardian last.
- A Child Agent or Advisor reviews only its own conversation; the root user's messages are not part of its evidence.
- Reviews cannot inspect files or run read-only checks (ADR-0001), so the policy leans conservative when evidence is missing.
- `git` read-only subcommands still honor repository configuration such as `core.fsmonitor` or `diff.external`; edits to `.git` are Sensitive Paths and therefore reviewed.
- Annotations and Safe Commands are trusted as declared; a tool that lies about `readOnlyHint` runs without review unless you configure it.
- `safeCommands` cannot remove a lower scope's entries.
- **Script runners run unreviewed code**: a Safe Command such as `npm test`, `pnpm lint`, or `make` executes whatever the workspace's `package.json` scripts, test files, and tool configuration say, and ordinary workspace edits to those files are not reviewed. Do not add script runners to `safeCommands` unless you accept that an agent can run arbitrary code through them. Likewise, extensions that act after edits, such as pi-formatter running formatters with workspace configuration, can execute code that Guardian never reviews.
- An ordinary edit that shares a tool batch with a reviewed call is reviewed only for the assistant message's own calls; concurrent nested calls of a `codemode` script are judged one by one.
- Hard links are detected only on existing files; Guardian cannot see a link a concurrent process creates after its check.

## Attribution

Guardian's built-in policy is adapted from the Guardian prompts of [OpenAI Codex](https://github.com/openai/codex) (`codex-rs/prompts/templates/guardian/`), Copyright 2025 OpenAI, licensed under the [Apache License, Version 2.0](http://www.apache.org/licenses/LICENSE-2.0). The adaptation (rewritten for Pi's tools, Trusted Evidence, a single stateless review, and an external Decision Table) is in [`src/guardian-prompt.ts`](src/guardian-prompt.ts). The Rejection wording follows Codex's.

## Troubleshooting

Run `/skill:pi-guardian`, or see [`skills/pi-guardian/SKILL.md`](skills/pi-guardian/SKILL.md).
