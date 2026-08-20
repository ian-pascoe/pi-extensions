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
`pi -e ./src/index.ts`. Requires Node `>=22.19.0` and Pi `>=0.84.1`.

## Configuration

Configure the extension in Pi's standard settings files:

- global: `~/.pi/agent/settings.json`
- project: `./.pi/settings.json`, when the project is trusted

Project values override global values. Run `/reload` after editing either file.

## Model roles

`minimalSubagents.modelRoles` gives the parent agent advisory names for
eligible models. The extension defines no roles itself, performs no task
classification, and does not route launches. The parent still passes the
ordinary `model` and `thinking_level` arguments separately.

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
or `max`) is a preferred `thinking_level`, not part of the canonical model
passed to `subagent`. Unsuffixed roles leave thinking selection independent.
Role names and hints are trimmed, single-line text. Names may be up to 64
characters and hints up to 500 characters. Models use canonical
`provider/model` IDs and must be available under the effective `enabledModels`
scope. The resolver matches the complete authored model ID first, so real
colon-bearing IDs—including IDs ending in `:high`—remain exact model IDs;
only an otherwise-unmatched recognized final suffix is treated as a thinking
preference. A thinking level pinned in `enabledModels` neither supplies nor
constrains a role preference, and normal spawn-time model-capability clamping
still applies.

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

## Capabilities and persistence

Child sessions are persistent Pi sessions. Their launch contracts bound model,
tool, project-context, session-context, delegation, and depth capabilities at
creation; reloading does not silently broaden them. The default maximum depth
is two levels beneath the interactive Root Agent.

The extension registers six coordinator tools for the Root Agent and fanout
children: `subagent`, `agent_message`, `subagent_wait`, `subagent_status`,
`subagent_cancel`, and `subagent_delete`. Ordinary non-fanout children receive
only the three adjacent-coordination tools: `agent_message`, `subagent_wait`,
and `subagent_status`.

The `subagent` `tools` argument distinguishes capability presets from exact
lists: `"read"` grants `read`, `grep`, `find`, and `ls`; `"modify"` adds
`bash`, `edit`, and `write`; an array such as `["read"]` grants exactly the
named ordinary tool and does not expand a preset. Coordinator tools are
injected separately according to delegation and must not appear in `tools`;
misuse returns an actionable error. Use the string preset when a child needs
the complete read-only discovery bundle.

`agent_message` reports whether a message was delivered through an active
parent wait, queued for the recipient, or failed. `subagent_wait` can return an
intermediate Wait Event containing a Coordination Message before the child turn
settles. That event claims only its message, so later unconsumed messages and the
terminal result retain automatic fallback. If the turn has already settled, one
wait returns its terminal result with queued messages in `messages`. Pass
optional `turn_id` to address an older retained turn exactly. Without it, waits
select the oldest observable claimed or pending turn before the active/latest
turn. A caller may have only one outstanding wait for the same source turn; a
concurrent duplicate is rejected instead of competing for one Wait Event.

The persisted Delivery Ledger records Coordination Messages, terminal results,
globally increasing sequence, and wait ownership before delivery. Existing
items retain their sequence; gaps from skipped malformed records are valid.
Claims can name only active, latest, or retained turns. Wait-returned messages
retain individual delivery evidence; terminal wait ownership remains durable
across reloads, forks, and newer turns. Automatic fallback retains its ordered
queue reservation while batching queued messages from one source turn into one
Pi steer. Root-bound messages remain batchable while the root turn is active; a
pending terminal result absorbs them. Child sessions drain all available steers
before the next model call. Destination-session Delivery Evidence still settles
each batched ledger item independently, preventing duplicate delivery and
unbounded checkpoint growth. The pure Delivery Ledger state machine retains at
most 20 pending wait-only terminal results per source agent; Coordination Messages
are not removed by that terminal-retention limit. Delivered messages include
stable delivery, source-agent, and source-turn identities in persisted details.

Deleting a child first verifies its session header and persistent identity,
then uses the optional `trash` command when available and falls back to
unlinking its session file. Deletion prunes pending delivery state and retained
recent-message projections sourced from the complete deleted subtree. Restore
and clone perform the same ownership check and reopen the recorded child-session
leaf.

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

## Status and TUI

Visible Child Agent rows show the canonical `provider/model:thinking` Runtime
Profile. Status uses the live Runtime Profile while a runtime exists and falls
back to the immutable Launch Contract otherwise. Live changes are observational:
they do not rewrite persistence or change nested spawn defaults.
