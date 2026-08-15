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
named tool and does not expand a preset. Use the string preset when a child
needs the complete read-only discovery bundle.

`agent_message` reports whether a message was delivered through an active
parent wait, queued for the recipient, or failed. `subagent_wait` can return an
intermediate Wait Event containing a Coordination Message before the child turn
settles; call it again for the terminal turn result. Once a wait returns an
intermediate message, that wait path owns the rest of the source turn: later
messages remain claimable by subsequent waits, and the terminal wait result
suppresses duplicate automatic delivery. Automatic results reserve their
recipient queue slot before the delivery grace period when no wait owns the
turn, but they do not enter Pi while the recipient is active. Once the
recipient settles, each deferred item resumes from its original queue position,
preserving ordering across turns. Delivered messages include the source agent
and turn identity in the model-visible envelope and in persisted details.

Deleting a child first uses the optional `trash` command when available and
falls back to unlinking its session file. Each Child Agent has a persistent
JSONL session. Append-only Root Agent Registry entries retain hierarchy and
Delivery Evidence across reloads. Forking cancels and drains active work, then
clones child session leaves so the fork receives an independent hierarchy.

## Status and TUI

Visible Child Agent rows show the canonical `provider/model:thinking` Runtime
Profile. Status uses the live Runtime Profile while a runtime exists and falls
back to the immutable Launch Contract otherwise. Live changes are observational:
they do not rewrite persistence or change nested spawn defaults.
