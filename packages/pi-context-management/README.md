# Pi Context Management

`@ian-pascoe/pi-context-management` lets a Pi agent continue work across native Context Windows using its own **Notes**, an explicit **Handoff**, a bounded recent **Tail**, and retrievable original **History**.

Requires Node `>=22.19.0` and a Pi runtime exposing the required checkpoint capabilities. The adapter checks runtime methods, writable hooks, and native append ownership rather than requiring an exact Pi version. Missing or lost capabilities fail closed before checkpoint mutation.

Development dependencies and the native compaction scheduling regression baseline are pinned to Pi `0.85.1`. Runtime checks validate interface shape, not persistence ordering or compatibility with every future Pi release. Pi still lacks arbitrary-time checkpoint mutation through its public extension API.

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
| `/context`         | Inspect Pi's native context usage and compaction settings, Notes, and recent Context Windows.                            |
| `/compact`         | Ask the agent to update Notes, write a fresh Handoff, and roll over.                                                     |
| `/rollover`        | Request preparation directly, including when native compaction has no history to compact.                                |

`context_rollover` must be the only direct call in its tool batch. Nested rollover, including through CodeMode, is rejected before checkpoint mutation. The extension does not change CodeMode exposure rules.

Notes use labels rather than filesystem paths. A session branch may hold up to 128 Notes; a Note name is 1–64 characters and content is at most 64,000 UTF-16 units. Lists and search return at most 20 results per page. Exact reads use zero-based UTF-16 offsets and return at most 2,000 units per call. Stable references have the form `context:<source-session>:<entry>`.

History is read-only and limited to recorded entries on the selected branch. Forks inherit entries on their selected path and then diverge; abandoned siblings and unrelated sessions are excluded. Context-only Child Agent inheritance does not copy the source Notes/History store, so an inherited reference may be unavailable locally. Foreign references resolve only when a persisted owned record proves the issuer had that entry; otherwise browse the current branch for a fresh reference. Reads do not open arbitrary external spill paths or reconstruct unavailable originals.

## Transcript previews

Note writes/appends and Rollover Handoffs display their text as tool arguments stream in. Collapsed previews use at most eight rendered lines, including the heading and any omission notice, and follow the newest text. Expand the tool output to read the full text. Completed writes and Rollover requests retain the preview; a saved Handoff still indicates a request, not a completed checkpoint. Other operations keep their compact summaries.

## Context Windows

A normal Rollover carries standing instructions, the agent-written Handoff, a Note Index of at most 4,000 characters, and a Tail selected by Pi's native retention policy. Tool calls stay with their results; omitted History remains retrievable. The extension does not shrink the Tail to satisfy a separate budget.

When Pi requests normal automatic or manual compaction, Context Management asks the agent to refresh useful Notes and call `context_rollover` alone with a fresh Handoff. This applies equally to TUI `/compact`, SDK, and remote compaction. The native summarizer is replaced, not called in addition. Preparation uses ordinary agent turns and can therefore make model requests. While preparation is pending, repeated threshold checks do not inject more reminders.

`/rollover [instructions]` requests preparation directly, even when Pi's native compaction preparation has no history to compact. Its instructions are limited to 2,000 characters. Pi owns `/compact`, including its model/auth and history checks. A redirected SDK `compact()` call rejects with `Compaction cancelled` while asynchronous fresh preparation proceeds; it does not return an immediate checkpoint result. The TUI may likewise display cancellation before the preparation notice. That cancellation is not a completed checkpoint. If preparation is cancelled, fails, or ends without Rollover, the extension reports noncompletion, leaves the existing conversation intact, and does not silently use a stale Handoff or repeatedly nudge the agent. Already acknowledged Notes remain saved; request `/rollover` explicitly to try again.

Actual native overflow is the exception: an Emergency Rollover immediately uses the last saved Handoff, marked stale or absent, rather than attempting another oversized preparation request. Native overflow includes Pi's recoverable truncated-response case. Recover recent work through History. All paths use the same native checkpoint representation. Resume, fork, tree navigation, and Pi's existing native inheritance consume that checkpoint directly. Running Child Agents and CodeMode processes are not replaced or patched.

Other extensions may observe or cancel native compaction; registering a listener is not a conflict. Inactive Autoresearch is supported. If another hook supplies compaction content, Context Management stops before checkpoint persistence and names that extension, regardless of load order. Disable the competing override before resuming. Empty observer results cannot trigger Pi's native summarizer fallback.

Pi alone owns context accounting, automatic compaction timing, and recent-history retention. There are no extension-owned 80%/90% thresholds or fit checks. Pi owns overflow retry and permits at most one rebuilt request. User cancellation does not trigger recovery, and completed tools are not replayed.

## Settings

Use Pi's native `compaction` settings in global `~/.pi/agent/settings.json` or trusted project `.pi/settings.json`:

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  }
}
```

These are Pi's defaults: `enabled` controls automatic compaction, `reserveTokens` controls its headroom, and `keepRecentTokens` controls recent-history retention. Disabling automatic compaction leaves manual compaction and explicit Rollover available. `/context` reports native usage and settings, not a separate estimate.

The obsolete `contextManagement` block is ignored, including `tailTokens`, `warningThreshold`, `emergencyThreshold`, `safetyMarginTokens`, and `outputReserveTokens`. If present in global or trusted-project settings, it produces one warning per session load pointing to native compaction settings. The extension neither edits configuration nor blocks continuation, even if the obsolete block is malformed. Remove it when convenient; there is no one-to-one migration of percentage thresholds.

Pi's usage is not an exact outgoing-request measurement. Initial oversized input or later growth in standing instructions, tool declarations, or other extensions' projections can still reach the provider limit. Native overflow recovery is the backstop; the extension does not intercept provider payloads, add a sizing margin, or promise that a fresh Handoff will fit.

## Failure behavior

Notes are persisted independently, so an acknowledged Note survives a later failed or cancelled Rollover. A checkpoint append failure leaves the prior Context Window selected, stops Context Management, and requires fixing the storage failure and reopening the persisted session (`/reload` alone is insufficient); rollback of Pi's speculative in-memory journal entries is not transactional. A post-append refresh failure preserves the committed checkpoint; reopening restores its Context Window.

Pi defers initial journal flush until an assistant response exists. If the first request is already too large, shorten it before retrying—the extension cannot safely create a durable checkpoint before the first assistant turn.

The extension uses Pi session entries only. It does not edit session files directly, add repository memory files, run a database or daemon, call a background model, use embeddings, replace the subagent framework, or manage CodeMode exposure.

This is privileged extension code: review it before installing it into an agent that can access local files, tools, or credentials.
