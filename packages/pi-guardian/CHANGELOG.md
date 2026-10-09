# @ian-pascoe/pi-guardian

## 0.2.1

### Patch Changes

- a5bdf9b: Allow pi-advisor's `advisor_report` tool by default so Advisor Sessions skip a Guardian Review for it; a `tools` entry still overrides.
- b72a811: Mark the last evidence block of a Guardian Review's request as a prompt-cache breakpoint on Anthropic and Bedrock models, so each review reads the previous review's cached evidence instead of only writing its own.
- 5ede42b: Review fewer read-only `bash` commands. The Safe Command parser now reads quotes as bash and `sh` do (only when Pi's `shellPath` is unset, bash, or sh; under zsh, dash, ksh, and mksh quoted syntax and redirects stay reviewed, and under any other shell no built-in program is a Safe Command) (single quotes are literal; in double quotes only `$`, backtick, `\`, and `!` are special, so `grep -E "a|b" file` runs unreviewed), accepts the exact stderr redirects `2>/dev/null` and `2>&1`, and treats `sed -n '<address>p' file` as a print-only built-in program.
- 37faf2f: Review fewer `cd` commands. A literal `cd` that Guardian cannot prove stays in the workspace (outside it, into a nested repository, or to a missing directory) no longer sends the whole command to a Guardian Review unless its target is a Sensitive Path. It leaves the directory unknown, as an `allow` Command Rule's `cd` already did: `git`, the only built-in program that loads configuration from the working directory, is then reviewed, as is any segment only an `allow` Command Rule permits, while the other built-in programs run. A `cd` to the home directory or an ancestor of it, and a later relative operand that may name a Sensitive Path from there (also after symlinks and `..`), are reviewed too. After an unknown `cd`, reads that follow symlinks (`grep -R`, `find -L`, `rg -L`) are reviewed, and a rule-allowed directory change (`pushd`, `popd`, an allowed `cd`) still judges later operands against the earlier directories. A relative `RIPGREP_CONFIG_PATH` makes `rg` reviewed. Non-literal `cd` targets (`$X`, `$(…)`, `-`, `~user`) are still reviewed.
- eed4468: Use the shared `@ian-pascoe/pi-utils/token-calibration` helper for the request-size calibration; Guardian's factors and evidence windows are unchanged.
- dd3f49e: Stagger the early reviews of a parallel tool batch: the first review starts at once and its siblings start when its request begins streaming (or when it settles, if it fails), so siblings read the prompt-cache entry the first one wrote instead of racing it.
- Updated dependencies [7ab488c]
- Updated dependencies [eed4468]
- Updated dependencies [58a2ce1]
  - @ian-pascoe/pi-utils@0.6.0

## 0.2.0

### Minor Changes

- 4ef1998: Guardian review and status entries now use Pi's custom-message box under a `[guardian]` label (`[guardian] ✗ rejected`) with Status Marks (`✓` allowed, `✗` rejected, `!` failed, `■` aborted, `○` off, `●` on), a ten-line Collapsed View with Pi's expand hint, expand or collapse when clicked, and the footer reads `● guardian on`. Warnings and errors are prefixed `Guardian:`, and the `/guardian` menu uses the shared settings menu. Requires Pi 1.1.0 or newer.

### Patch Changes

- Updated dependencies [4ef1998]
- Updated dependencies [4ef1998]
  - @ian-pascoe/pi-utils@0.5.0

## 0.1.0

### Minor Changes

- 9b5cae5: Add Pi Guardian, disabled by default until `/guardian on` or `"enabled": true`: gates every tool call, including calls a `codemode` script issues, with a Tool Policy (`allow`, `review`, or `deny`; read-only tools, ordinary workspace edits, and Safe Commands, including pipelines and lists of them and `cd` into the workspace, run without review) and Command Rules that allow, review, or deny `bash` commands by literal prefix without a model call (`deny` also covers `terminal_start` and `powershell`). Other calls go to a Guardian Review, one stateless call to a reviewer model that scores the call's Risk Level and User Authorization from reasoning-blind evidence: the user's messages and the agent's tool calls, never its text, reasoning, or tool results. `high` and `critical` risk must name a concrete Risk Category, and a would-be Rejection is rechecked by a careful Escalation Pass before a fixed Decision Table rejects it. A Pi classifier model such as TypeSafe's Jev (`classifierModel`) can make the First Pass instead, escalating to a language model when it would reject, when its Rejection Probability reaches `escalationThreshold`, or when it fails. A Rejection tells the agent not to work around it and to ask the user, Review Failures never allow a call silently, a Rejection Streak ends the turn, and interactive users can allow a call once. Every review is recorded in the session, and `/guardian` opens a settings menu and status. Minimal Subagents Child Agents and Advisors follow the root session's settings, and a Child Agent trusts a task or message its parent's Guardian approved as user-authorized, for that Child Agent only.

### Patch Changes

- Updated dependencies [ac8fb7a]
- Updated dependencies [9b5cae5]
  - @ian-pascoe/pi-utils@0.4.0
