# Codex experimental context management (GPT-6 Astra)

_Researched 2026-09-05 against Codex CLI 0.153.x and `openai/codex` source at `588b781ab4924ce7352488394028e63d74cf807f`._

## Conclusion

The announced feature is **experimental context management**, configured as:

```toml
[features.context_management]
experimental_mode = true
```

It is a Codex harness plus private ChatGPT-backend feature, not an inherent `gpt-6-astra` API capability. It combines three mechanisms:

1. token-budgeted context-window rollover;
2. private, backend-backed `history` and `notes` model tools; and
3. a zero-argument `new_context` tool that starts a fresh window without summarizing the old one.

The public OpenAI API does **not** document these history/notes services or `new_context`. A third-party client can reproduce the workflow locally, but cannot obtain Codex's exact hosted feature merely by selecting Astra. Calling Codex's private `alpha/history/v2/*` and `alpha/notes/v2/*` routes would be unsupported and version-sensitive.

## What OpenAI announced

OpenAI describes this as “a new way for Codex to preserve and retrieve context when the context window fills”: Astra keeps notes across windows, while earlier messages and tool results remain searchable even when omitted from the notes. OpenAI contrasts it with repeatedly compressing the conversation into one summary and calls it experimental pending a future Astra default.[^astra]

The Codex 0.153.0 changelog gives its implementation name, config key, and activation bundle: **token-budget context, history notes, and the `new_context` tool**.[^changelog] The config reference says it is off by default and requires ChatGPT sign-in on Plus, Pro, or Pro Lite.[^config]

Although announced with Astra, current activation code does not itself test the selected model slug; it tests the feature flag, account, provider, and backend. Therefore “Astra context management” should not be treated as a model wire-protocol feature.[^activation]

## Mechanics

### Window lifecycle

- Codex tracks numbered context windows with opaque UUIDs for the first, previous, and current window. It sends window identity plus `history_ingest_requested: true` in Codex turn metadata when history/notes is active.[^window-state][^metadata]
- Near the token limit, model-owned guidance instructs the model to write or append a concise checkpoint containing the goal, decisions, progress, learnings, next steps, and relevant window/item IDs. If the budget is exhausted, fallback guidance restricts the next actions to one notes write/append followed by `new_context`.[^model-guidance]
- `new_context` takes no arguments. Its contract says it starts a new context window without changing environment state; its result says the next window starts without summarizing history.[^new-context]
- After the model's tool follow-up, Codex rolls over if `new_context` was requested or the token budget is exhausted. It replaces active model history with initial instructions/current world state (and selected retained client developer messages), advances the window ID, and uses an empty compaction message—there is no model/server summary.[^rollover][^fresh-window]
- The shell, working tree, running environment state, and other harness state are not reset. The removed conversation remains recoverable through `history` once backend ingestion catches up.

### Does experimental rollover keep a transcript tail?

**No.** `start_new_context_window` rebuilds initial/current world-state context and replaces the old history. By default it carries no old user/assistant/tool messages: even the current user request and the triggering `new_context` call/result are absent. The integration test explicitly asserts that the original user request is missing after rollover. Base instructions and current tool definitions are supplied again outside the discarded conversation, and recovery guidance directs the model to its checkpoint Notes and then History. A bounded notes thread hint may also be supplied by the backend; it is not a raw transcript tail.

One narrow exception is bounded client-authored developer messages under `RetainClientDeveloperMessages`, an under-development feature that defaults to false. This is not retention of recent ordinary conversation.

Sources at the inspected commit: [`session/mod.rs:4207–4254`](https://github.com/openai/codex/blob/588b781ab4924ce7352488394028e63d74cf807f/codex-rs/core/src/session/mod.rs#L4207-L4254), [`tests/suite/token_budget.rs:1546–1577`](https://github.com/openai/codex/blob/588b781ab4924ce7352488394028e63d74cf807f/codex-rs/core/tests/suite/token_budget.rs#L1546-L1577), and [`features/src/lib.rs`](https://github.com/openai/codex/blob/588b781ab4924ce7352488394028e63d74cf807f/codex-rs/features/src/lib.rs). This is the experimental `new_context` path, not ordinary Codex compaction.

### History and notes

These are direct-model-only Codex tools backed by authenticated POST requests to private Codex backend routes:[^history-tools][^history-backend]

- `history.list_windows`, `history.list_items`, `history.read_item`, `history.search_contents`
- `notes.list_files_by_prefix`, `notes.read_file`, `notes.search_contents`, `notes.append_to_file`, `notes.write_file`

History is normalized, read-only, addressed by agent/window/item IDs, and eventually consistent. Notes use virtual—not local filesystem—paths under `<agent_name>/notes`, can be accessed across agents, and survive window transitions within the rollout. Successful writes are immediately readable, while note listing/search is eventually consistent. Codex also requests a bounded backend-generated `notes` thread hint for new-window context.[^history-tools][^history-extension]

## Comparison with the proposed Pi design (Q7–Q9)

These are comparisons with design proposals, not claims about an implemented Pi package.

- **Q7 — Notes exposure:** Codex does not inject every Note. Its context contributor requests a backend-provided `notes.thread_hint`, bounded to **4,000 UTF-8 bytes**, and the model can list/search/read Notes on demand. The client source does not reveal how the backend generates that hint; do not assume a separate summarization model. Our proposal instead injects an explicit agent-written Handoff, a configurable Tail, and a deterministic Note-name index, then reads Note contents on demand. Sources: [`extension.rs:31`](https://github.com/openai/codex/blob/588b781ab4924ce7352488394028e63d74cf807f/codex-rs/ext/history-notes/src/extension.rs#L31), [`extension.rs:98–150`](https://github.com/openai/codex/blob/588b781ab4924ce7352488394028e63d74cf807f/codex-rs/ext/history-notes/src/extension.rs#L98-L150), and [`tools.rs`](https://github.com/openai/codex/blob/588b781ab4924ce7352488394028e63d74cf807f/codex-rs/ext/history-notes/src/tools.rs).
- **Q8 — History discovery:** Codex exposes window listing, item listing, bounded exact reads, and case-sensitive literal substring search using stable opaque IDs. Calls default to the current agent but can inspect another agent; History ingestion is eventually consistent. Our proposed operations closely match this, but read already-persisted Pi entries on the active branch without a hosted ingestion step. This deliberately excludes unrelated agent/session histories. Source: [`tools.rs:26–27,72–89,119–122,180`](https://github.com/openai/codex/blob/588b781ab4924ce7352488394028e63d74cf807f/codex-rs/ext/history-notes/src/tools.rs).
- **Q9 — User visibility:** Codex's History/Notes tool descriptions explicitly designate them private model-only state and instruct silent recovery. Its TUI exposes general context usage through the footer and `/status`; no dedicated user-facing Notes/window inspector was found in the inspected command definitions. Our proposed Rollover notice and read-only inspector are a deliberate transparency addition. Sources: [`tools.rs:26–27`](https://github.com/openai/codex/blob/588b781ab4924ce7352488394028e63d74cf807f/codex-rs/ext/history-notes/src/tools.rs#L26-L27), [`slash_command.rs`](https://github.com/openai/codex/blob/588b781ab4924ce7352488394028e63d74cf807f/codex-rs/tui/src/slash_command.rs), and [`chatwidget/turn_runtime.rs`](https://github.com/openai/codex/blob/588b781ab4924ce7352488394028e63d74cf807f/codex-rs/tui/src/chatwidget/turn_runtime.rs).

The already-accepted Pi Tail (configurable, default 16k tokens) is a separate intentional difference: Codex's experimental rollover has no transcript Tail.

## Not Responses API compaction

The public Responses API has a different feature named `context_management` with a `compact_threshold`, plus a standalone `/responses/compact` endpoint. Both produce an opaque compaction item that carries summarized/condensed prior state into a smaller next context.[^api-compaction]

That public mechanism does **not** expose searchable historical windows, writable notes, Codex window/item IDs, or a `new_context` tool. The shared phrase “context management” does not imply protocol equivalence.

## Availability and third-party clients

Codex 0.153.0 enables experimental context management only when all current eligibility checks pass:[^changelog][^activation]

- ChatGPT authentication;
- Plus, Pro, or Pro Lite account plan;
- the OpenAI provider using Codex backend routes and OpenAI auth; and
- no provider environment API key, experimental bearer token, custom auth/credentials, AWS provider, or temporary structured thread.

This is narrower than Astra model availability. OpenAI separately says Astra is available through the OpenAI API, Azure, and AWS Bedrock, and to additional ChatGPT plan types; that does not grant Codex's experimental context-management backend.[^astra]

For a third-party harness such as Pi:

- **Exact Codex service: not publicly supported.** The history/notes routes are `alpha/*` paths under the ChatGPT Codex backend, use Codex auth, attach ingestion metadata, and are absent from the public API documentation.
- **Equivalent local behavior: feasible.** A client can persist model-authored notes, index archived transcript items by window, expose list/read/literal-search tools, and replace the active prompt with initial/current state at rollover. This recreates the behavior, not OpenAI's hosted storage/protocol.
- **Ordinary public compaction: available now but different.** Use Responses `context_management` or `/responses/compact` when an opaque compacted state is sufficient.

## Pi package feasibility

Pi's public extension surface supports the core local equivalent:

- `ctx.sessionManager.getBranch()` exposes archived entries on the active branch, including entries omitted from current model context after compaction. A history tool can list, read, and search those persisted entries by stable ID.
- `pi.appendEntry()` can persist model-authored note revisions; restore from the active branch rather than mixing notes from abandoned branches.
- `session_before_compact` can return extension-owned checkpoint text and a retained-history boundary, bypassing the default recursive LLM summarizer. The `context` hook can shape the model-visible messages without deleting the underlying transcript.
- `ctx.getContextUsage()` provides budget feedback; `ctx.compact()` exposes compaction initiation.

Sources: [Pi extension API](https://github.com/earendil-works/pi/blob/da840b6216578c2a571d0374ac6a2091a83f9d91/packages/coding-agent/docs/extensions.md), [Pi compaction API](https://github.com/earendil-works/pi/blob/da840b6216578c2a571d0374ac6a2091a83f9d91/packages/coding-agent/docs/compaction.md).

A basic notes-plus-retrieval package does not require CodeMode's private registry bridge. Exact fresh-window rollover during an active tool loop still needs a prototype to verify boundary selection, automatic continuation, usage accounting, and compatibility with pending async jobs. Preserve tool call/result pairs and current task constraints; do not discard the active window until its notes are durably saved. Retrieval covers persisted transcript content, not tool output that was never stored or spills already deleted. Literal search is sufficient for the initial version; Codex's own tool contract specifies literal substring search.

## Sources

[^astra]: OpenAI, [“GPT-6 Astra: A new generation of intelligence”](https://openai.com/index/gpt-6-astra/), especially “Coding” and “Availability” (2026-09).

[^changelog]: OpenAI, [Codex CLI 0.153.0 changelog](https://developers.openai.com/codex/changelog#codex-cli-01530), “Configuration and API Updates” (2026-09-03); implementation PR [#42385](https://github.com/openai/codex/pull/42385).

[^config]: OpenAI, [Codex Configuration Reference: `features.context_management.experimental_mode`](https://learn.chatgpt.com/docs/config-file/config-reference#feature-flags).

[^activation]: `openai/codex`, [`core/src/session/token_budget.rs`](https://github.com/openai/codex/blob/588b781ab4924ce7352488394028e63d74cf807f/codex-rs/core/src/session/token_budget.rs).

[^window-state]: `openai/codex`, [`core/src/state/auto_compact_window.rs`](https://github.com/openai/codex/blob/588b781ab4924ce7352488394028e63d74cf807f/codex-rs/core/src/state/auto_compact_window.rs).

[^metadata]: `openai/codex`, [`core/src/session/session.rs`](https://github.com/openai/codex/blob/588b781ab4924ce7352488394028e63d74cf807f/codex-rs/core/src/session/session.rs) and [`core/src/responses_metadata.rs`](https://github.com/openai/codex/blob/588b781ab4924ce7352488394028e63d74cf807f/codex-rs/core/src/responses_metadata.rs).

[^model-guidance]: `openai/codex` 0.153.0, [`models-manager/models.json`](https://github.com/openai/codex/blob/rust-v0.153.0/codex-rs/models-manager/models.json) (`token_budget.reminder_message_template` and `auto_compact_fallback_prompt`).

[^new-context]: `openai/codex`, [`new_context_window_spec.rs`](https://github.com/openai/codex/blob/588b781ab4924ce7352488394028e63d74cf807f/codex-rs/core/src/tools/handlers/new_context_window_spec.rs) and [`new_context_window.rs`](https://github.com/openai/codex/blob/588b781ab4924ce7352488394028e63d74cf807f/codex-rs/core/src/tools/handlers/new_context_window.rs).

[^rollover]: `openai/codex`, [`core/src/session/turn.rs`](https://github.com/openai/codex/blob/588b781ab4924ce7352488394028e63d74cf807f/codex-rs/core/src/session/turn.rs).

[^fresh-window]: `openai/codex`, [`core/src/compact_token_budget.rs`](https://github.com/openai/codex/blob/588b781ab4924ce7352488394028e63d74cf807f/codex-rs/core/src/compact_token_budget.rs) and [`core/src/session/mod.rs`](https://github.com/openai/codex/blob/588b781ab4924ce7352488394028e63d74cf807f/codex-rs/core/src/session/mod.rs).

[^history-tools]: `openai/codex`, [`ext/history-notes/src/tools.rs`](https://github.com/openai/codex/blob/588b781ab4924ce7352488394028e63d74cf807f/codex-rs/ext/history-notes/src/tools.rs).

[^history-backend]: `openai/codex`, [`ext/history-notes/src/backend.rs`](https://github.com/openai/codex/blob/588b781ab4924ce7352488394028e63d74cf807f/codex-rs/ext/history-notes/src/backend.rs).

[^history-extension]: `openai/codex`, [`ext/history-notes/src/extension.rs`](https://github.com/openai/codex/blob/588b781ab4924ce7352488394028e63d74cf807f/codex-rs/ext/history-notes/src/extension.rs).

[^api-compaction]: OpenAI API docs, [Compaction](https://developers.openai.com/api/docs/guides/compaction).
