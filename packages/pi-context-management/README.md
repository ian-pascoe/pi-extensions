# Pi Context Management

`@ian-pascoe/pi-context-management` lets a Pi agent continue work across native Context Windows using its own **Notes**, an explicit **Handoff**, a bounded recent **Tail**, and retrievable original **History**.

Requires Node `>=22.19.0` and a Pi runtime exposing the required checkpoint capabilities. The adapter checks runtime methods, writable hooks, and native append ownership rather than requiring an exact Pi version. Missing or lost capabilities fail closed before checkpoint mutation.

The SDK regression suite passes on Pi `0.85.0` and `0.85.1`; development dependencies remain pinned to `0.85.1`. Runtime checks validate interface shape, not persistence ordering or compatibility with every future Pi release. Pi still lacks arbitrary-time checkpoint mutation through its public extension API.

## Install

```bash
pi install npm:@ian-pascoe/pi-context-management
# or from this checkout
pi -e ./packages/pi-context-management/src/index.ts
```

## Tools and commands

| Surface            | Purpose                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `context_notes`    | List, read, write, append, delete, or literally search named Markdown Notes.                                             |
| `context_history`  | Browse Context Windows and entries, read exact recorded entry JSON, or perform case-sensitive literal search.            |
| `context_rollover` | Save an explicit agent-written Handoff and request an immediate native Context Checkpoint after the complete tool batch. |
| `/context`         | Inspect budget usage, Notes, and recent Context Windows without changing them.                                           |
| `/compact`         | In the TUI, ask the agent to update Notes, write a fresh Handoff, and roll over.                                         |
| `/rollover`        | Request the same preparation flow directly, including outside the TUI.                                                   |

`context_rollover` must be the only direct call in its tool batch. Nested rollover, including through CodeMode, is rejected before checkpoint mutation. The extension does not change CodeMode exposure rules.

Notes use labels rather than filesystem paths. A session branch may hold up to 128 Notes; a Note name is 1–64 characters and content is at most 64,000 UTF-16 units. Lists and search return at most 20 results per page. Exact reads use zero-based UTF-16 offsets and return at most 2,000 units per call. Stable references have the form `context:<source-session>:<entry>`.

History is read-only and limited to recorded entries on the selected branch. Forks inherit entries on their selected path and then diverge; abandoned siblings and unrelated sessions are excluded. Context-only Child Agent inheritance does not copy the source Notes/History store, so an inherited reference may be unavailable locally. Foreign references resolve only when a persisted owned record proves the issuer had that entry; otherwise browse the current branch for a fresh reference. Reads do not open arbitrary external spill paths or reconstruct unavailable originals.

## Transcript previews

Note writes/appends and Rollover Handoffs display their text as tool arguments stream in. Collapsed previews use at most eight rendered lines, including the heading and any omission notice, and follow the newest text. Expand the tool output to read the full text. Completed writes and Rollover requests retain the preview; a saved Handoff still indicates a request, not a completed checkpoint. Other operations keep their compact summaries.

## Context Windows

A normal Rollover carries standing instructions, the Handoff, a Note Index of at most 4,000 characters, and a Tail of complete recent message/tool-result groups. The Tail allowance is a maximum, not a guaranteed allocation. Oversized groups are omitted whole and remain available through History references.

In the TUI, `/compact [instructions]` starts a normal agent turn to refresh Notes and write a fresh Handoff before Rollover. `/rollover [instructions]` requests the same preparation directly. Instructions are limited to 2,000 characters. Preparation can be interrupted without creating a checkpoint; already acknowledged Notes remain saved. Pi owns `/compact`, so the extension cancels its immediate native compaction before starting preparation; Pi may display `Compaction cancelled`, followed by the preparation notice. Pi's native model/auth and history checks still apply before this redirect.

SDK/RPC manual compaction, threshold compaction, overflow, and Emergency Rollover remain immediate and non-interactive, using the last saved Handoff marked stale or absent. These paths add no model or summarization request. All paths use the same native checkpoint representation. Resume, fork, tree navigation, and Pi's existing native inheritance consume that checkpoint directly. Running Child Agents and CodeMode processes are not replaced or patched.

Other extensions may observe or cancel native compaction; registering a listener is not a conflict. Inactive Autoresearch is supported. If another hook supplies compaction content, Context Management stops before checkpoint persistence and names that extension, regardless of load order. Disable the competing override before resuming. Empty observer results cannot trigger Pi's native summarizer fallback.

At 80% of the model's full context window the extension warns the agent to prepare Notes and a Handoff. At 90% it performs an Emergency Rollover using the last saved Handoff, marking it stale or absent and directing recovery through History. Neither threshold subtracts the model's output limit. The input estimate includes standing instructions, tool declarations, and the safety margin. The effective Tail shrinks before the Handoff or standing context is sacrificed; an oversized Handoff fails with an actionable error rather than being truncated.

Pi owns overflow retry and permits at most one rebuilt request. User cancellation does not trigger recovery, and completed tools are not replayed.

## Settings

The extension reads `contextManagement` from Pi's global `~/.pi/agent/settings.json` and trusted project `.pi/settings.json`:

```json
{
  "contextManagement": {
    "tailTokens": 16000,
    "warningThreshold": 0.8,
    "emergencyThreshold": 0.9,
    "safetyMarginTokens": 2048
  }
}
```

| Setting              | Default | Constraint                                                                          |
| -------------------- | ------: | ----------------------------------------------------------------------------------- |
| `tailTokens`         | `16000` | Non-negative maximum Tail allowance.                                                |
| `warningThreshold`   |   `0.8` | Fraction of the full context window; less than `emergencyThreshold`.                |
| `emergencyThreshold` |   `0.9` | Fraction of the full context window; greater than `warningThreshold` and below `1`. |
| `safetyMarginTokens` |  `2048` | Conservative accounting margin, minimum `256`.                                      |

The former `outputReserveTokens` setting has been removed; delete it from existing `contextManagement` settings before reloading.

Trusted project values override global values. Invalid settings are reported and the extension fails closed rather than guessing a policy. Reload Pi after changing settings.

Budgeting compares two complete estimates: Pi's usage-backed total plus any extra live message projection, and the current messages plus standing instructions/tool declarations. It takes the larger estimate and adds the safety margin once. Before valid usage and immediately after a Context Checkpoint, current-content estimation still reserves standing instructions and tools.

These are rough estimates, not exact request measurements. Older usage can hide later growth in instructions or tools, and live session state can differ from the outgoing request. Such growth may reach the provider's context limit before an Emergency Rollover; Pi's existing overflow recovery remains the backstop. The extension does not intercept provider payloads or restrict other extensions' request changes. `/context` reports the same approximate budget.

## Failure behavior

Notes are persisted independently, so an acknowledged Note survives a later failed or cancelled Rollover. A checkpoint append failure leaves the prior Context Window selected, stops Context Management, and requires fixing the storage failure and reopening the persisted session (`/reload` alone is insufficient); rollback of Pi's speculative in-memory journal entries is not transactional. A post-append refresh failure preserves the committed checkpoint; reopening restores its Context Window.

Pi defers initial journal flush until an assistant response exists. If the first request is already too large, shorten it before retrying—the extension cannot safely create a durable checkpoint before the first assistant turn.

The extension uses Pi session entries only. It does not edit session files directly, add repository memory files, run a database or daemon, call a background model, use embeddings, replace the subagent framework, or manage CodeMode exposure.

This is privileged extension code: review it before installing it into an agent that can access local files, tools, or credentials.
