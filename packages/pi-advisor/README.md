# Pi Advisor

`@ian-pascoe/pi-advisor` reviews a Pi agent's completed work and surfaces concise, attributed corrective advice when it finds material instruction violations, scope drift, repeated failures, or unsupported completion claims.

Requires Pi `0.85.1` and Node `>=22.19.0`. Other Pi versions pause review with an explicit compatibility error.

## Install

```bash
pi install npm:@ian-pascoe/pi-advisor
# or from this checkout
pi -e ./packages/pi-advisor/src/index.ts
```

Advisor is **disabled by default**. Configuration precedence is session, trusted project, global, then package defaults. Settings use Pi's native settings files and session entries; no separate database or transcript store is created.

## Commands

```text
/advisor status
/advisor on|off [--global|--project]
/advisor inherit [key] [--global|--project]
/advisor set <key> <JSON> [--global|--project]
/advisor prompt [--global|--project]
/advisor set includeSubagents true
/advisor set model "provider/model-id"
```

Argument autocomplete suggests command names, settings keys, and valid trailing scope flags.

`prompt` opens Pi's native editor and replaces the whole Advisor Prompt. `inherit` removes an override at the selected scope. Invalid keys and values are rejected. Lists, including `allowedTools`, replace the inherited list rather than merge. `catchUpThreshold` accepts any positive safe integer or `"off"`; `reviewTimeoutMs` accepts 1–2,147,483,647 milliseconds (the native timer range).

## Defaults and access

| Option                         | Default                      |
| ------------------------------ | ---------------------------- |
| Enabled                        | `false`                      |
| Watched sessions               | Main only                    |
| Allowed tools                  | `read`, `grep`, `find`, `ls` |
| Catch-up threshold             | `3`                          |
| Review deadline                | 120 seconds                  |
| Investigative calls per Review | 8                            |
| Automatic Corrective Turns     | 1 per request/task           |

A Tool Grant names tools; it does not sandbox their full native interfaces. Explicitly granting `lsp`, for example, permits its native operations, including mutations. Unavailable names are ignored and reported. CodeMode-only tools require an explicitly compatible transport grant; Advisor never adds aliases, autogrants missing tools, or changes CodeMode exposure.

The Advisor inherits each observed agent's model and thinking level independently unless configured otherwise. One root policy can cover current and future Minimal Subagents descendants when enabled.

## Sessions and Context Management

Each watched agent has a private, persisted native Advisor Session with fresh, session-bound extension resources. Reviews reuse that session until context or configuration changes require rebuilding. Opaque inline or custom extension resources that cannot be safely recreated are reported as unsupported and pause the Advisor; they are not silently reused or omitted. The Advisor's session state remains separate from the observed agent's state.

Context Management is optional. If loaded and its tools are granted, `context_notes`, `context_history`, and `context_rollover` operate on the Advisor's private context. If any of those three tools is excluded, the Advisor pauses before reviewing. There is no autogrant or hook bypass.

## Scheduling and safety

Reviews combine completed observed turns (one model response plus its tool batches) and use bounded catch-up waits of at most 30 seconds. Each Review has its own deadline and tool-call budget. Findings are deduplicated without merging distinct code identifiers; ordinary concerns observe a three-turn cooldown, while blockers bypass cooldown but not duplicate or per-Review limits.

Running work receives native steering. A blocker after normal interactive completion may receive a tracked corrective continuation within the configured budget; aborted, uncertain, deliberately interrupted, and headless-completed work is preserved without a hidden restart. Child corrections stay inside Minimal's owned operation. Headless root shutdown allows only a bounded final drain and never starts hidden corrective work.

Status reports effective settings, sources, review state, backlog, usage/cost, and the last error. Unknown cost is shown as unknown, never zero. Review failure pauses Advisor while leaving the observed agent running; changing configuration, branch, or session identity invalidates stale in-flight work.

Advisor is privileged extension code. Review inherited extensions and granted tools before installing it in a session with access to local files, credentials, or mutating APIs.
