# Pi Advisor

`@ian-pascoe/pi-advisor` reviews a Pi agent's completed work and surfaces concise, attributed findings for material problems and worthwhile low-risk cleanup.

Requires Node `>=22.19.0` and Pi `>=0.99.0`.

## Install

```bash
pi install npm:@ian-pascoe/pi-advisor
# or from this checkout
pi -e ./packages/pi-advisor/src/index.ts
```

Advisor is **disabled by default**. Configuration precedence is session, trusted project, global, then package defaults. Settings use Pi's native settings files and session entries; no separate database or transcript store is created.

## Commands

```text
/advisor
/advisor status
/advisor on|off [--global|--project]
/advisor inherit [key] [--global|--project]
/advisor set <key> <JSON> [--global|--project]
/advisor prompt [--global|--project]
/advisor set includeSubagents true
/advisor set model "provider/model-id"
/advisor set maxFindingsPerReview 4
```

Argument autocomplete suggests command names, settings keys, and valid trailing scope flags.

In the interactive TUI, `/advisor` alone opens a settings menu built from Pi's native settings list, like `/settings`. A Scope row chooses where edits are written (session, trusted project, or global), and each setting shows its effective value with any non-default source. `enabled`, `includeSubagents`, and `thinkingLevel` cycle the selected scope's own value in place (`inherit → on → off`, or through each thinking level); while that scope has none, the row shows what it inherits, such as `inherit (on · project)`, and a value overridden by a higher-precedence scope is marked. Model, tools, numbers, and the prompt open submenus, and the prompt uses Pi's own editor component. Every edit is validated and applied immediately; a paused Advisor shows its reason and a Resume row. Closing the menu records one status entry listing the changes it applied, or nothing if none were. Without the TUI, `/advisor` records the status entry instead.

`/advisor status` and the other subcommands each record a status entry in the transcript. Collapsed, it shows state, model, backlog, usage and cost, unavailable tools, and the last error; expanded, it lists every setting with its source and each watched Child Agent. A mutating command's entry starts with the changes it applied. While enabled, the footer shows `advisor` when idle, `advisor: reviewing`/`consulting` with any `backlog N`, or `advisor: paused`, plus Child Agents that are reviewing or paused. `advisor_ask` renders its question and a Markdown answer preview, and Child Agent findings carry a `↳ <agentId>` label.

Interventions render with their severity and Advisor attribution. Long Nits collapse until expanded; Concerns and Blockers always show in full.

## On-demand consultations

When Advisor is enabled, the main agent can call `advisor_ask({ message })` for analysis or a second opinion. The call waits for the current Review, then returns plain Markdown before any further Review Backlog is processed. Follow-up calls continue the same private Advisor Session.

A Consultation receives only observed context that has not already been supplied to that Advisor. It does not reduce the Review Backlog, create an Intervention, or trigger a Corrective Turn. Its ordinary tool call and result remain in the observed transcript for later Reviews.

The tool is absent while Advisor is disabled. A paused Advisor keeps it visible so the call can report the pause reason and recovery commands. User cancellation stops only that Consultation; an inference, authentication, deadline, or investigative-tool failure pauses Advisor. With Pi's built-in `codemode` active, scripts can call it too; under `codemode.mode: "only"` its declaration is hidden and it is reachable only through `codemode` scripts.

Consultation authorizes analysis and investigation, not implementation or other side effects. The configured Advisor Prompt remains authoritative. Tool Grants still expose each granted tool's full native interface, so exclude mutating tools when a prompt-level boundary is insufficient.

`prompt` opens Pi's native editor and replaces the whole Advisor Prompt. `inherit` removes an override at the selected scope. Invalid keys and values are rejected. Lists, including `allowedTools`, replace the inherited list rather than merge. `catchUpThreshold` accepts any positive safe integer or `"off"`; `reviewTimeoutMs` accepts 1–2,147,483,647 milliseconds (the native timer range); `maxFindingsPerReview` accepts an integer from 1 through 32.

`advisor_ask` declares MCP-style `annotations` (read-only, non-destructive, idempotent, closed-world) that Pi reports through `pi.getAllTools()` for permission extensions; Pi does not send them to model providers. They describe the consultation itself, not the tools granted to the Advisor. The Advisor Session's internal `advisor_report` tool, which extensions inherited by that session can see, declares non-destructive, closed-world annotations and is not read-only, because it records the Review's findings.

## Defaults and access

| Option                         | Default                      |
| ------------------------------ | ---------------------------- |
| Enabled                        | `false`                      |
| Watched sessions               | Main only                    |
| Allowed tools                  | `read`, `grep`, `find`, `ls` |
| Catch-up threshold             | `3`                          |
| Review deadline                | 120 seconds                  |
| Investigative calls per Review | 8                            |
| Findings per Review            | 4                            |
| Automatic Corrective Turns     | 1 per request/task           |

A Tool Grant names tools; it does not sandbox their full native interfaces. Explicitly granting `bash`, for example, permits any command, including mutations. Unavailable names are ignored and reported; status reflects the Advisor Session at that moment, so a granted tool that registers later, such as an MCP tool after its server connects, is reported until it does. Advisor never autogrants missing tools. Granted tools with `codemode` or `deferred` exposure (such as tools from Pi's built-in MCP) are not declared to the Advisor model; they stay callable from granted `codemode` scripts, and a granted `tool_search` can declare them, as in the observed agent. Granting `codemode` lets the Advisor script its other granted tools; it inherits the observed `codemode.mode`, so under `"only"` the Advisor calls `advisor_report` from a script. It also inherits whether scripts get the `models` API: Minimal Subagents Child Agents have none, so neither do their Advisors.

The Advisor inherits each observed agent's model and thinking level independently unless configured otherwise. One root policy can cover current and future Minimal Subagents descendants when enabled.

## Sessions and Context Management

Each watched agent has a private, persisted native Advisor Session with fresh, session-bound extension resources. Reviews reuse that session until context or configuration changes require rebuilding. Pi's enabled `builtin:<name>` extensions are recreated in their observed order: `codemode`, `tool-search`, and `mcp` from Pi's exported factories, and `llama.cpp` from the installed Pi package's shipped extension file, retaining their metadata and fresh provider state. Built-ins disabled with `-builtin:<name>` stay absent. This is a built-in recreation recipe, not general inline-factory support; a host factory registered under a built-in name is rejected. Other opaque inline or custom extension resources that cannot be safely recreated are reported as unsupported and pause the Advisor; they are not silently reused or omitted. The Advisor's session state remains separate from the observed agent's state.

Reviews and Consultations receive Review Evidence: what the observed model saw, not Pi's stored records. Messages keep their role, text, reasoning text, tool calls with arguments, tool-result text with error status, and image attachments; replay signatures, display-only tool `details`, provider metadata, and native IDs are omitted. Each tool call and its result share a short reference. Redacted reasoning and responses that errored, aborted, or hit the output limit are marked. The first Review or Consultation in an Advisor Session carries a Context Seed: the observed system prompt and each observed tool's name and one-line summary (not its full description or schema), plus the current conversation. Later Reviews and Consultations add only new messages.

Context Management is optional. If loaded and its tools are granted, `context_notes`, `context_history`, and `context_rollover` operate on the Advisor's private context. If any of those three tools is excluded, the Advisor pauses before reviewing. There is no autogrant or hook bypass.

## Scheduling and safety

Reviews combine completed observed turns (one model response plus its tool batches) and use bounded catch-up waits of at most 30 seconds. Each Review has its own deadline, investigative-call budget, and configurable finding limit. One terminating report returns findings in severity order. Formatting-equivalent findings retain their highest severity within a Review; later escalation from Nit to Concern to Blocker remains deliverable. Distinct Concerns are delivered together when eligible or retained together for re-evaluation during the three-turn cooldown.

Nits are non-interrupting and enter context at the next natural step boundary without starting a Corrective Turn. Running work receives native steering for eligible Concerns and Blockers. A Blocker after normal interactive completion may receive a tracked corrective continuation within the configured budget; aborted, uncertain, deliberately interrupted, and headless-completed work is preserved without a hidden restart. Child corrections stay inside Minimal's owned operation. Headless root shutdown allows only a bounded final drain and never starts hidden corrective work.

Status reports effective settings, sources, review or consultation state, backlog, usage/cost, and the last error. Unknown cost is shown as unknown, never zero. Review failure pauses Advisor while leaving the observed agent running; changing configuration, branch, or session identity invalidates stale in-flight work.

Advisor is privileged extension code. Review inherited extensions and granted tools before installing it in a session with access to local files, credentials, or mutating APIs.
