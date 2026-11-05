# Minimal Subagents

## Install and load

Install the package from npm:

```bash
pi install npm:@ian-pascoe/pi-minimal-subagents
```

Installing the Git collection enables every extension in the repository:

```bash
pi install git:github.com/ian-pascoe/pi-extensions
```

To select only Minimal Subagents from that Git package, set its extension
filter in `~/.pi/agent/settings.json` using the repository-relative path:

```json
{
  "packages": [
    {
      "source": "git:github.com/ian-pascoe/pi-extensions",
      "extensions": ["packages/pi-minimal-subagents/src/index.ts"]
    }
  ]
}
```

From this package checkout, load the source directly with
`pi -e ./src/index.ts`. Requires Node `>=22.19.0` and Pi `>=1.1.0`.

## Typical workflow

1. `subagent` launches a Child Agent from a self-contained task: by default the
   child starts without the parent's conversation. It returns at once with its `agent_id`,
   `turn_id`, and resolved model, thinking level, tools, delegation, and any
   tool-resolution `warnings`. Spawns run sequentially, so a `subagent_wait` or
   `agent_message` in the same tool batch can target the new child.
2. `subagent_wait` claims the turn's result, or leave it unclaimed and the final
   response arrives automatically as a steer message. Without `turn_id`, a wait
   skips turns whose result you already claimed or received automatically, and
   never repeats an automatically delivered result: it reports
   `already_delivered: true` instead of the output. If the result is handed to Pi but
   not yet in your conversation, it also sets `delivery_pending: true` and the
   result arrives as a separate message; no reread needed.
3. `agent_message` continues an idle child: the result reports
   `disposition: "started-turn"` with the new `turn_id`. A plain
   `subagent_wait({ agent_id })` targets that new turn, not the first result;
   pass `turn_id` to re-read a turn whose result is still retained, claimed or
   not.
4. `subagent_status` inspects children; `subagent_cancel` stops work but keeps
   the session; `subagent_delete` removes it. A deleted child's ID can be
   reused, and the new child starts fresh; generated `agent-N` IDs are never
   reused. Spawning with a live child's `agent_id` fails with that child's
   state and the next step (`agent_message`, `subagent_delete`, or another
   `agent_id`).

## Configuration

Configure the extension in Pi's standard settings files:

- global: `~/.pi/agent/settings.json`
- project: `./.pi/settings.json`, when the project is trusted

Project values override global values. Run `/reload` after editing either file.

## Subagent Access

`minimalSubagents.enabled` controls whether the six Root Agent Coordinator
Tools start active. It defaults to `true`; a trusted project value overrides
the global value.

```json
{
  "minimalSubagents": {
    "enabled": false
  }
}
```

Use `/subagents` to inspect or change access without editing JSON:

```text
/subagents
/subagents status
/subagents enable|disable|reset
/subagents enable|disable|reset --global
/subagents enable|disable|reset --project
```

Bare `/subagents` means `status`. Unscoped changes apply to the selected
session-tree branch. `reset` removes that override and follows project, global,
then the built-in default. Scoped changes update both the selected branch and
the chosen settings file; project changes require a trusted project. A malformed
settings file is left unchanged and reported with its path.

Disabling Subagent Access removes all six Coordinator Tools from the Root
Agent while preserving unrelated tools. It does not cancel or alter existing
Child Agents, their Launch Contracts or fanout capability, Coordination Message
delivery, or terminal-result delivery. Reload and resume preserve the selected
branch override, `/tree` restores the newly selected branch, forks inherit the
source branch, and a new branch without an override follows settings.

## Model roles

`minimalSubagents.modelRoles` gives the parent agent named, advisory choices of
eligible models. The extension defines no roles itself, performs no task
classification, and does not route launches: the parent names the role it wants
with the optional `role` argument of `subagent`.

```json
{
  "minimalSubagents": {
    "modelRoles": {
      "budget": "opencode-go/glm-5.2:low",
      "design": {
        "model": "opencode-go/kimi-k3:high",
        "hint": "UI design, visual critique, and frontend polish"
      }
    }
  }
}
```

A recognized final suffix (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`,
or `max`) is the role's `thinking_level`, not part of the canonical model.
Unsuffixed roles leave thinking selection independent: the child uses the
caller's thinking level unless `thinking_level` is passed.
Role names and hints are trimmed, single-line text. Names may be up to 64
characters and hints up to 500 characters. Models use canonical
`provider/model` IDs and must be available under the effective `enabledModels`
scope. The resolver matches the complete authored model ID first, so real
colon-bearing IDs—including IDs ending in `:high`—remain exact model IDs;
only an otherwise-unmatched recognized final suffix is treated as a thinking
preference. A thinking level pinned in `enabledModels` neither supplies nor
constrains a role preference, and normal spawn-time model-capability clamping
still applies.

### Launching with a role

`subagent({ task, role: "design" })` launches the child with the `design` role's
model and, when the role has a suffix, its thinking level. An explicit `model` or
`thinking_level` overrides the role's value independently, so
`{ role: "design", thinking_level: "low" }` keeps the role's model with a
different thinking level. The role is recorded even when explicit `model` and
`thinking_level` override all of its values. An unknown `role` fails before any
child is created and lists the configured role names. The Launch Contract
records the resolved `model` and `thinking_level` together with the `role` used
(`role` is absent when none was named), and `subagent_status` and the expanded
`subagent` result show it. Recording the name does not tie the child to the role: later settings
changes never alter an existing Launch Contract.

Roles are read when the session starts, so editing `modelRoles` mid-session
changes nothing until a reload. The `role` parameter is a plain string rather
than an enum of the configured names, so the tool definition stays
byte-identical when `modelRoles` changes. Only the role list in the system
prompt (the `subagent` prompt guidelines) changes, and only at reload. The
`model` enum is separate: it already follows the eligible models.

Global and project roles merge by name in settings order. Expanded role
objects merge by field; a project string replaces the whole global entry. A
project can remove one inherited role with `null`, or clear all inherited
roles by setting `modelRoles` to `null`.

```json
{
  "minimalSubagents": {
    "modelRoles": {
      "budget": null
    }
  }
}
```

Invalid or unavailable entries are omitted. The extension emits one
consolidated startup warning and keeps every valid role.

## Subagent model references

Point the Root Agent at a model for its subagents with `%name`, or
`%name:level` for a thinking level, anywhere in a user message. Type `%` to open a completion popup of model roles and eligible
models, like `$skill`, `&server`, and `#123` in the sibling selectors. A
reference only points. It doesn't launch a Child Agent or change the Root Agent's
own model, and the Root Agent decides whether to pass it to `subagent`.

### Submission

Typed, pasted, and selected references are equivalent. On submission:

```text
Plan with %design, then review with %claude-opus-5-5.
→ Plan with [%design](model-role://design "Subagent model role: role=design"), then review with [%claude-opus-5-5](model://anthropic/claude-opus-5-5 "Subagent model: model=anthropic/claude-opus-5-5").
```

With a thinking level:

```text
Plan with %design:low, then review with %claude-opus-5-5:high.
→ Plan with [%design:low](model-role://design "Subagent model role: role=design, thinking_level=low"), then review with [%claude-opus-5-5:high](model://anthropic/claude-opus-5-5 "Subagent model: model=anthropic/claude-opus-5-5, thinking_level=high").
```

The label keeps what you typed. The title names the `subagent` arguments and
their values. A level after a role overrides the role's own thinking level, as
an explicit `thinking_level` does. A role link leaves out the role's model, which the `subagent` prompt
guidelines already list. The submitted transcript stores the links rather than
a separate raw message. Submitting converted text again changes nothing.

### Names

A reference converts when its exact, case-sensitive name is one of these, in
this precedence:

1. an eligible model's full `provider/id`;
2. a configured model role;
3. a bare model id that exactly one eligible model has. `%claude-opus-5-5`
   converts only if no other provider offers `claude-opus-5-5`.

A name may end in `:level`, one of the thinking levels its model supports
(`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, as Pi reports for
that model; a role uses its model's levels). The whole text is read as a name
first, so an id that itself ends in `:text`, such as `amazon.nova-2-lite-v1:0`,
keeps it. Such an id that several providers share stays literal rather than
being read as a shorter name plus a level.

These stay literal:

- unknown or ambiguous names, and `%Large` for a role named `large`
- a level the model doesn't support (`%gpt-4o:high` for a model without
  reasoning), or one in another case (`%large:High`)
- names followed by any other `:text` (`%large:ultra`), `@text`, `~text`, `/`,
  `-`, or `.word`
- `50%`, `a%20b`, `%PATH%`, `\%large`, code, existing links, and HTML

Sentence punctuation does not block a reference: `(%large)`, `%large's`,
`%large.`, and `%large: review this` all convert.

### The catalogue

The models are exactly the `subagent` tool's `model` enum: authenticated models
within the effective `enabledModels` scope. The roles are the valid configured
`modelRoles`. Both are read when the session starts and change only on reload,
like the enum. The root's current model is not listed unless it is eligible;
omit `model` to inherit it.

Some entries are left out:

- a model whose id contains characters other than letters, digits, and
  `. _ : / ~ @ + -`, or that doesn't end in a letter or digit
- a role whose name doesn't start and end with a letter or digit or contains
  such characters (`UI design`). It still works through the `role` argument.
- a role named like an eligible model's full id

References are offered and converted only while the Root Agent can reach
`subagent`: it is active, or callable through `codemode` or `deferred` exposure.
After `/subagents disable`, `%large` stays literal and the popup is hidden,
silently. Links already sent stay as they are.

### Completion popup

`%` after a token boundary, or alone at the start of a line, lists roles first,
then models, each with names that start with the query first and then
alphabetical. The filter is case-insensitive. It matches role names, model
`provider/id`s, and model display names. The popup closes at a space, so type
one word of a display name. Selecting a model inserts its full
`%provider/id`. Descriptions list the thinking levels each entry supports:
`Subagent role · provider/model:thinking · off/…/high · hint` and
`Subagent model · Display Name · off/…/high`.

Typing `:` straight after a name that converts lists its supported levels, in
Pi's order: `%claude-opus-5-5:` offers `%claude-opus-5-5:off` through
`%claude-opus-5-5:max`, and `%large:h` narrows to `%large:high`. The name
before the colon is case-sensitive. A level is not offered where `name:level`
is itself a model id or role name; that name is listed instead when it
converts.

Pi's editor opens the popup by itself only for characters the outermost
autocomplete provider lists in `triggerCharacters`. If another extension wraps
the provider without forwarding them, press Tab after `%`. See
[ADR 0008](docs/adr/0008-reference-subagent-models-with-percent.md) for why `%`.

### Integration

The popup runs in the interactive terminal only. Conversion applies to
interactive, RPC (`prompt`, `steer`, and `follow_up`), and print input,
including the first `pi -p` prompt, and it keeps attachments. Input from other
extensions is unchanged. The tool definitions and system prompt are unchanged,
so earlier history and the prompt-cache prefix stay byte-identical.

### Troubleshooting

- **No popup:** type `%` after a space, and check that `/subagents status`
  reports Subagent Access enabled and `subagent` active, or that another
  extension exposes it through `codemode` or `deferred`. If another extension
  wraps the autocomplete provider, press Tab.
- **No link:** check the exact case-sensitive name and whether the bare id is
  shared by several providers. A `:level` must be one the model supports; type
  `%name:` to list them. Also check whether the reference is escaped, in code,
  or followed by other `:text`, `@text`, or `~text`. Reload after changing `modelRoles` or
  `enabledModels`.
- **The Root Agent used another model:** inspect the submitted user message
  first. A correct link verifies conversion; using it is the Root Agent's
  choice.

## Maximum delegation depth

`minimalSubagents.maxSubagentDepth` is a positive safe integer. It counts
subagent levels beneath the interactive root: `1` permits root children, `2`
also permits grandchildren, and so on. The default is `2`.

```json
{
  "minimalSubagents": {
    "maxSubagentDepth": 1
  }
}
```

A trusted project value replaces the global value. Project `null` restores
the built-in default of `2`. An invalid project value emits a warning and
leaves a valid global value in effect.

Reloading with a lower depth does not delete existing agents or change their
launch contracts. Before `/reload` invalidates the old extension runtime, the
extension waits for active child and root work to settle, then disposes idle
child runtimes. A deliberately non-settling agent can therefore delay reload
indefinitely. The new limit controls restored tool availability and future
spawn attempts; the root retains recursive hierarchy management.

## Toolsets

Configure ordinary tools using case-sensitive minimatch pattern strings. For
example:

```json
{
  "minimalSubagents": {
    "baseToolset": ["context_*"],
    "readToolset": ["read", "grep", "find", "ls"],
    "modifyToolset": ["bash", "edit", "write", "lsp_*", "dap_*"]
  }
}
```

The defaults are `baseToolset: []`,
`readToolset: ["read", "grep", "find", "ls"]`, and
`modifyToolset: ["bash", "edit", "write"]`. Each configured array replaces that
key's inherited value; `[]` clears it. Omitted keys inherit the global value or
built-in default. Only trusted project settings apply.

Tool Presets are cumulative:

- `tools: "read"`: Base Toolset + `readToolset`.
- `tools: "modify"`: Base Toolset + `readToolset` + `modifyToolset`.
- `tools: "none"` or `tools: []`: Base Toolset only.
- `tools: ["read"]`: Base Toolset + exactly `read`; arrays do not expand patterns
  or presets.
- Omitted `tools`: Base Toolset + the caller's Reachable Tools: the Root Agent's
  active tools plus tools scripts can call without declaring them (`codemode` or
  `deferred` exposure, such as MCP tools), or a Child Agent caller's own grant.

Patterns select from permitted ordinary tool names, including inactive tools
registered at the root. Their matches are unioned in pattern order, retaining
registry order within each pattern and removing duplicates at first occurrence.
Each pattern is independent: a negated minimatch pattern matches its complement;
it does not subtract earlier matches. Coordinator Tools remain separately controlled by delegation.

Invalid configuration entries and patterns matching no permitted ordinary tools
warn and are skipped. Configured tools unavailable in child resources are also
skipped with a warning, rather than blocking launch. Explicit and inherited tool
requests remain strict. A child never gains capabilities beyond its parent's
ceiling, including when a restored parent predates a newly configured Base
Toolset. Use status to inspect the concrete grant if an optional plugin is absent.

Pattern expansion happens when a Child Agent is created. `/reload` applies
settings to future launches without changing existing Launch Contracts. If a tool
in an existing contract later disappears, normal restoration dependency checks
still apply; the saved grant is not silently rewritten. Toolsets configure names,
not tool operations: granting a multifunction tool grants that tool's available
operations, regardless of preset name.

Child Agents load Pi's built-in `llama.cpp`, `codemode`, and `tool-search`
extensions unless settings disable them (`-builtin:<name>`). They load the `mcp`
extension, under the same setting, only when the Launch Contract grants an MCP tool
(`mcp__<server>__<tool>`) or an MCP resource tool (`list_mcp_resources`,
`list_mcp_resource_templates`, `read_mcp_resource`). Each such child connects
its own copy of the `mcp.json` servers it can reach: the servers of its granted
MCP tools, or every server when it is granted a resource tool. Servers that other
extensions register with `pi.registerMcpServer()` still all connect. Pi does not
export its `mcp.json` loader, so children load it from Pi's installed
`dist/extensions/mcp/config.js`; when that file is absent, a child with an MCP
grant connects every server. Pi does not export the llama.cpp factory, so children load it
from Pi's installed `dist/extensions/llama/index.js`; when that file is absent, a
llama.cpp launch model is reported as a missing dependency. Child `codemode`
scripts get no `models` API, so they cannot call models outside the Launch
Contract. A tool's exposure still decides whether it is declared or reachable only
through `codemode` or `tool_search`. Granted `codemode`- or `deferred`-exposed
tools are callable but not declared, so a child that needs them also needs
`codemode` or `tool_search` in its grant. Ungranted tools are unreachable in the
child, including MCP tools: `codemode` and `tool_search` find and call only the
MCP tools the Launch Contract names. MCP tools are checked at launch only by name, because children register
them after connecting; a tool whose server disappeared fails when called. Closing
a child runtime shuts its extensions down, closing its MCP connections. A reopened
child re-declares the tools it last declared itself, including tools loaded
through `tool_search`; as in Pi, a tool that registers only after the child opens,
such as an MCP tool, is not re-declared. Declarations inherited from the parent's
context are not restored.

## Capabilities and persistence

Child sessions are persistent Pi sessions. Their launch contracts bound model,
tool, project-context, session-context, delegation, and depth capabilities at
creation; reloading does not silently broaden them. The default maximum depth
is two levels beneath the interactive Root Agent.

The extension registers six coordinator tools for the Root Agent and fanout
children below the depth cap: `subagent`, `agent_message`, `subagent_wait`, `subagent_status`,
`subagent_cancel`, and `subagent_delete`. Children that cannot spawn (delegation
`none`, or fanout at the depth cap) have no children to wait on or inspect, so they
receive only `agent_message`.

A running child's `latest_activity_at` advances with the timestamps of its latest
messages and tool results. Targeted `subagent_status` includes `recent_activity`, a bounded tail of message
text, reasoning, tool calls, and tool results. It includes the current streaming
assistant message but omits image data. Timeout Wait Events carry only a compact
progress snapshot. Children target only direct children; the Root Agent
may inspect any descendant. Model-facing status reports a `child_count` but no
nested `children` summaries. Reported `usage` always includes `cacheWrite1h`
and `reasoning`, as `0` when the provider reports none. `structuredContent`
rounds every `usage.cost` field to six decimal places of USD;
exact values stay in session data. `subagent_cancel`
lists in `affected_agent_ids` only agents whose active turns it cancelled.

Coordinator Tools give the model compact text, not JSON: a spawn is one line
naming the tool preset and count rather than the tool list; a settled wait is
status, elapsed time, one token and cost total, then the output; cancel and
delete are one line each, and a cancel that found nothing running says so.
Targeted `subagent_status` opens with a summary line, lists active tools once,
describes the Launch Contract grant and capability ceiling relative to them,
and previews the task, latest output, and last three Recent Activity items;
`verbose: true` adds the full task, output, ceiling, usage breakdown, recent
messages, and Recent Activity. Codemode scripts receive the complete record in
`structuredContent`, and the transcript renderer reads `details`.

`session_context` defaults to `omit`: the child starts with only its system
prompt and task, so the task should be a self-contained brief covering the goal,
target files and non-goals, the change or question, and acceptance criteria.
Opt in to `inherit` to copy the parent's conversation, or `compact` to summarize
it first, only when the child needs that discussion. Inheriting is costly: the
child's system prompt differs from its parent's, so the copied conversation
cannot reuse the parent's prompt cache, and `compact` adds a summarization call.
With either opt-in, the parent's conversation is quoted rather than replayed as
the child's own turns: each parent message becomes one
`minimal-subagents.parent-context` custom message, sent to the model as
user-role text wrapped in `<parent_message from="…" role="…">`. Tool calls and
results become text, a custom message's label names its `customType`, and an
errored, aborted, or length-limited parent turn is marked as incomplete. Images
are kept; parent reasoning and the parent's system prompt and tool declarations
are omitted, since the child declares its own. Each quoted message stays a
separate session entry, so `compact` can still summarize older entries. The task
is then framed as a handoff: the quoted conversation is background, its requests
belonged to the parent, and the child's own assignment follows. Quoting keeps
the parent's turns distinct from the child's own; it does not guarantee that a
child, particularly a small model, ignores the quoted requests. Existing Child Agents keep the mode recorded in their Launch Contracts.

The `subagent` `tools` argument distinguishes configurable Tool Presets from
exact lists; every selection also receives the permitted Base Toolset described
above. Coordinator tools are injected separately according to delegation and
must not appear in explicit `tools` arrays; misuse returns an actionable error.
Child sessions load the Root Agent's
configured settings and extensions, excluding the recursive
`pi-minimal-subagents` entrypoint. Project Context controls only project-scoped
AGENTS instructions and skills; omitting it retains user instructions and
skills plus project settings, extensions, providers, and tools. A configured
`pi-codex-conversion` adapter replaces a complete granted tool group only,
including the `"read"` preset's `read`, `grep`, `find`, and `ls` tools. Exact
tool arrays are replaced only when they contain the complete source group.
Because Codex performs discovery through `exec_command`, an adapted `"read"`
preset is not an enforced read-only boundary. Status reports effective adapter
tools while the Launch Contract continues to record the originally granted
capability names.

`agent_message` reports whether a message was delivered through an active
parent wait (`delivered-via-wait`), queued into the recipient's active turn
(`queued`), started a new turn on an idle child (`started-turn`, with its
`turn_id`), or failed. A failed delivery and a
partially failed `subagent_delete` return an error result (`isError: true`) that
still carries the declared structured output, so the model sees an error while
codemode scripts receive the `failures` or `error` data instead of a data-less
rejection. `subagent_wait` can return an
intermediate Wait Event containing a Coordination Message before the child turn
settles. That event claims only its message, so later unconsumed messages and the
terminal result retain automatic fallback. If the turn has already settled, a
wait returns its terminal result with queued messages in `messages`; waiting
again for a settled turn you claimed returns the same result while it is
retained. Pass optional `turn_id` to address a retained turn exactly, including
one whose result you already claimed (a claimed result stays retained until
Delivery Evidence settles it). Without it, waits skip claimed turns and turns
whose result was already delivered to you automatically, and select the oldest
remaining observable turn, falling back to the active, then latest, turn. When
that fallback reaches a result already delivered to you automatically, whether
still queued or settled, the wait returns `event: "turn"` with
`already_delivered: true`, the turn identity, and status, but no output; it does
not claim the turn, and `turn_id` rereads the full result. A result handed but
not yet recorded in your branch also carries `delivery_pending: true`: it will
arrive as a separate message (redelivered if Pi discards the queued steer), so no reread is needed. A
caller may have only one outstanding wait for the same source turn; a
concurrent duplicate is rejected instead of competing for one Wait Event.
When `timeout_ms` expires, the wait returns an observational `event: "timeout"`
with the requested turn identity and a compact, bounded progress snapshot
(`state`, `elapsed_ms`, `latest_activity_at`, `total_tokens`, and the labels of
the last three Recent Activity items as `recent_activity_labels`), under about 1 KB. It omits the task and
Launch Contract; targeted `subagent_status` returns the full detail.
It removes only the waiter, leaving the child
running and all pending delivery unclaimed. Abort signals remain errors.

A wait that would block also ends early when a Queued Steer is pending for the
caller's session, because Pi hands a steer to an agent only after every tool call in
the current batch returns. It returns an `event: "steered"` Wait Event with the
requested turn identity and the same compact progress snapshot as a timeout, and,
like a timeout, removes only its waiter: nothing is claimed, the child is not
cancelled, and later messages and the terminal result keep automatic fallback.
A wait that starts while a steer is pending returns `steered` at once, but a
retained result or pending Coordination Message is still returned first. Only steers
count (a user's mid-run message, a parent's Coordination Message into a busy child, or
another child's result steered into the caller); follow-ups never do. A child
session's steer clears when its next turn starts or its run ends.

The persisted Delivery Ledger records Coordination Messages, terminal results,
globally increasing sequence, and wait ownership before delivery. Existing items
retain their sequence; gaps from skipped malformed records are valid. Claims can
name only active, latest, or retained turns. Wait-returned messages retain
individual delivery evidence; terminal wait ownership remains durable across
reloads, forks, and newer turns. Automatic fallback retains its ordered queue
reservation while batching queued messages from one source turn into one Pi
steer. Root-bound messages remain batchable while the root turn is active; a
pending terminal result absorbs them. If Pi discards a root-bound steer before
consuming it, as Esc does, the next root turn boundary reporting an empty Pi
queue releases the result: a default wait selects it again at once, and
automatic fallback re-sends it, ahead of newer results, into the root run if it
is still going, or, after an abort such as Esc, when the root's next run starts.
Recovery never starts a root turn by itself. Child sessions drain all available
steers before the next model call. Destination-session Delivery Evidence still
settles each batched ledger item independently, preventing duplicate delivery
and unbounded checkpoint growth. The pure Delivery Ledger state machine retains
at most 20 pending wait-only terminal results per source agent; Coordination
Messages are not removed by that terminal-retention limit. Delivered messages
include stable delivery, source-agent, and source-turn identities in persisted
details.

Deleting a child first verifies its session header and persistent identity,
then uses the optional `trash` command when available and falls back to
unlinking its session file. Deletion prunes pending delivery state and retained
recent-message projections sourced from the complete deleted subtree. Restore
and clone perform the same ownership check against the recorded child-session
leaf. Restoration loads metadata and validates saved sessions without starting
child runtimes or their extension services (including MCP Servers). Status,
saved transcripts, settled-result waits, cancellation of idle children, and
session management do not start runtimes. A message or an undelivered child-bound
result opens only its recipient's runtime on demand; saved Delivery Evidence
prevents already-delivered work from reopening it. Runtime initialization errors
are reported when that child is first needed.

Registry replay and Delivery Evidence are scoped to the Root Agent's active
session-tree branch. Registry writes use V2 records with complete field,
identity, sequence, hierarchy, adjacency, destination, ordinary-tool ceiling,
and coordinator-tool exclusion validation. Every available V2 agent has a
selected leaf; only unavailable recovery placeholders may omit it. Valid V1
records and checkpoints migrate during replay; invalid owned records are
skipped with semantic diagnostic codes rather than disabling the extension.
Persisted message activity carries an explicit `recorded_at` from the
coordinator clock.

`/tree` abandons old process-local work and restores the selected branch. Fork
preparation is read-only; only confirmed fork shutdown interrupts work and
clones the selected branch, so another extension can cancel a fork without
freezing coordinator tools. Each clone records a new generation-specific
identity/provenance pair, and the destination appends ownership for that clone's
current session ID rather than reusing inherited ownership. If a
process-local fork handoff is lost, recovery reads only the destination's
selected branch and proceeds only when its canonical `parentSession` proves the
source file; it never substitutes the source session's newer head.

Every child session also carries an Agent Lineage Record, defined by
`@ian-pascoe/pi-utils/agent-lineage`, naming its own session, its Root Agent's
session, its agent ID, and its parent agent. Other extensions read it to find a
Child Agent's ancestors and descendants without depending on this package; it
grants them nothing. A fork clone writes its own record when its destination
adopts it. Children created before the record existed have none.

## Tool annotations

The coordinator tools declare MCP-style `annotations`, which Pi reports through `pi.getAllTools()` for permission extensions and does not send to model providers. `subagent` is destructive and open-world because a Child Agent can use any tool it is granted. `agent_message` is not read-only but is non-destructive and closed-world. `subagent_cancel` is non-destructive and idempotent; `subagent_delete` is destructive and idempotent. `subagent_status` and `subagent_wait` are read-only (`subagent_wait` consumes queued deliveries, so it is not idempotent).

## Status and TUI

Coordinator tool calls and results stay readable without expanding. A
`subagent` call shows the launch settings the caller chose and its task; an
`agent_message` call shows its message. While `subagent_wait` blocks, it shows
the child's tool-call count and, on a tree rail, the latest work of the turn
being waited on, rendered with Pi's own message and tool components as in the
`/subagents` viewer and refreshed each second; collapsed, the rail keeps the
newest items within 20 lines. A settled wait shows the child's output as
Markdown, or its error, with duration, tokens, and cost. Long text previews its
first 10 lines, like Pi's `read`. Every collapsed result ends its first line
with Pi's tool-expansion hint (normally Ctrl+O), which reveals the rest and the
full detail. Automatic agent results and messages preview the same way.

In TUI mode, `/subagents` or `/subagents status` opens a large, centered,
overlay in Pi's selector frame. Up/Down selects a Child Agent; Enter opens its Child Session
Transcript. Escape returns to the tree, then Escape closes the overlay. The
viewer is read-only: Root Agent input and ongoing agent work remain intact.

Two consecutive Left Arrow presses within 500 ms open the same viewer when
the main editor is focused and completely empty. Drafts (including whitespace),
dialogs, and other overlays retain normal navigation. Explicit key-repeat
reports are ignored; legacy terminals cannot distinguish holding Left from
two presses.

The viewer and compact widget prioritize sibling subtrees containing running
Child Agents. Idle ancestors move with active descendants, parents stay above
their children, and equally active siblings retain their original order. Viewer
selection follows the Child Agent's identity through live reordering.

The transcript includes inherited context, earlier turns, pre-compaction
messages, and live output on the selected saved branch. Abandoned branches and
internal bookkeeping are excluded. Saved history can be inspected without
restoring a runtime; missing or unverified sessions report an explanation rather
than substituting another branch. Model-facing Recent Activity remains bounded.

Transcripts open at the latest output and refresh once per second. Up/Down
scrolls by line, Page Up/Page Down by page. Scrolling up pauses following; End
returns to live output. Reading position is retained through resize and tool
expansion. Reasoning is visible, tool output starts collapsed, and Pi's configured
tool-expansion key (normally Ctrl+O) reveals it. Images appear as explicit text
placeholders rather than inline images.

The tree header reports the effective access source, authored settings, direct
running/idle counts, and actual Coordinator Tool activation. Partial external
activation is reported as `N/6 active`; status does not repair it.

RPC mode receives a concise status notification. JSON and print modes produce
no observer-only output.

Visible Child Agent rows show the canonical `provider/model:thinking` Runtime
Profile. Status uses the live Runtime Profile while a runtime exists and falls
back to the immutable Launch Contract otherwise. Live changes are observational:
they do not rewrite persistence or change nested spawn defaults.
