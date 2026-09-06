# Pi plugins for Codex-style context memory

_Researched 2026-09-05. Package metadata and source were inspected; no candidate was installed or runtime-tested._

## Recommendation

Evaluate **`@cortexkit/pi-magic-context` first**. It is the only stock-Pi package found that combines explicit model-writable notes/memory, search and exact expansion of raw history omitted from the live prompt, and active context-window reduction. It supports Pi 0.85.1 by declared peer range and has by far the strongest maintenance/adoption signals among the close matches.

It is still **not an exact Codex implementation**. Magic Context continuously transforms the prompt and replaces older history with model-generated “compartments”; Codex starts a fresh window without summarizing the old one, relying on explicit notes plus backend history retrieval. Magic Context's Pi `ctx_search` searches raw history from the current session, while durable memories provide its cross-session knowledge. Treat README claims such as “effectively unbounded” and “never forgets” as positioning, not guarantees.

If deliberate handoff/reset semantics matter more than historical retrieval, **`pi-agenticoding`** is the next candidate to prototype. If a simpler compaction-plus-recall system is acceptable, consider **`pi-mcb`**, but its Pi 0.85 compatibility is undeclared.

## Fit criteria

The target workflow has three independent parts:

1. **Notes:** model-writable durable checkpoint/notes state.
2. **Archived retrieval:** list/read/search of raw material no longer in active context.
3. **Rollover:** replace the active window while keeping the session/environment alive.

Ordinary memory injection or custom compaction alone is not a full match.

## Shortlist

| Candidate                                                                                         | Notes                                                                                         | Archived retrieval                                                                                                            | Rollover/context control                                                                                                    | Pi 0.85.1                                                               | Verdict                                                              |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------- |
| [`@cortexkit/pi-magic-context` 0.41.3](https://www.npmjs.com/package/@cortexkit/pi-magic-context) | **Yes:** `ctx_note` and cross-session `ctx_memory`                                            | **Yes:** `ctx_search` over current-session raw messages and `ctx_expand` for exact recovery                                   | **Yes, different mechanism:** per-call transform, historian compartments, queued `ctx_reduce`; cancels native Pi compaction | **Declared compatible:** peers `>=0.80.2`                               | **Best overall match; evaluate first**                               |
| [`pi-agenticoding` 0.5.0](https://www.npmjs.com/package/pi-agenticoding)                          | **Yes:** branch-local notebook/custom entries and handoff state                               | **No broad raw-transcript search**                                                                                            | **Yes:** handoff compaction can remove old model-visible history and rehydrate notebook state                               | **Declared compatible:** peer `>=0.84.1`                                | Best deliberate-reset alternative, but incomplete and broad in scope |
| [`pi-mcb` 0.2.0](https://www.npmjs.com/package/pi-mcb)                                            | **Partial:** background model-authored observations/reflections, not a general note-file tool | **Yes, same session:** BM25-lite/regex over JSONL, exact expansion, branch/all-session scope; optional semantic memory search | **Yes, different mechanism:** deterministic compaction plus retained tail, not a fresh unsummarized window                  | **Undeclared:** developed against Pi `^0.84.3`, but omits Pi from peers | Strong integrated partial match; prototype before relying on it      |
| [`pi-observational-memory` 3.0.4](https://www.npmjs.com/package/pi-observational-memory)          | **Partial:** model-authored observations and durable reflections                              | **Weak:** exact source recovery requires an already-known 12-char memory ID; explicitly not search/browsing                   | **Yes, different mechanism:** proactive tiered compaction; falls back to Pi when projection is empty                        | **Metadata accepts it:** wildcard peers; developed against `^0.81.0`    | Good observational memory, not a Codex history service               |
| [`@pi-unipi/compactor` 2.16.0](https://www.npmjs.com/package/@pi-unipi/compactor)                 | **No explicit notes:** deterministic continuity snapshots only                                | **Yes, same session:** BM25/regex `session_recall` over append-only branch                                                    | **Yes, different mechanism:** zero-LLM structured compaction and optional percentage trigger                                | **Incompatible peer range:** `^0.84.0` means `<0.85.0`                  | Technically strong, but not viable on Pi 0.85.1 as published         |

### 1. `@cortexkit/pi-magic-context`

The Pi-specific package is not merely an OpenCode wrapper. Its source registers `ctx_search`, `ctx_memory`, `ctx_note`, `ctx_expand`, and `ctx_reduce` through Pi's `ExtensionAPI`; uses Pi's `context` hook to replace model-visible messages before each LLM call; and cancels `session_before_compact` while its own context manager is enabled. Raw Pi session JSONL is indexed and can be recovered by ordinal. The package also includes Pi-specific lifecycle, clone/resume, cache, and Docker E2E coverage, though those tests were not run here.[^magic-pi]

Important limitations and costs:

- A configured historian model is required for history compaction. Historian failure leaves older history uncompressed and produces warnings.
- Context rollover is compartment summarization and prompt transformation, not Codex's zero-summary `new_context` boundary.
- Raw message search is session-scoped; cross-session continuity comes primarily from promoted project memory and notes rather than a general archive browser across every old Pi session.
- It is a large system with SQLite, embeddings/ONNX, subprocess agents, a dreamer, dashboard integration, and many dependencies. Historian/dreamer tasks send selected session/project material to their configured model providers.
- It owns context management and intentionally disables itself when conflicting context managers are detected. Do not combine it with another compactor.

Maintenance evidence is strong: npm 0.41.3 was published 2026-09-04, the repository had about 2,030 stars and was active during this review, and its peer range includes the installed Pi 0.85.1. The inspected repository head was `edba4c0c9dfda8fddbcfb095c6f91d20bdbfd4c6`.[^magic-readme]

### 2. `pi-agenticoding`

Its notebook uses branch-local durable custom entries and rehydrates state after history replacement. Its handoff path deliberately advances with a supplied task/checkpoint while dropping old model-visible context, making its reset philosophy closer to Codex than recursive summarization. It does not provide Codex-like raw transcript list/read/search tools, so details omitted from the notebook are not conveniently recoverable by the model.

It also bundles spawning, model groups, and readonly-agent behavior. That overlaps with an existing minimal-subagents setup and makes it a poor choice if only context memory is wanted. Source at `2941487d39166a1fd2b197e971e331988c659171` (2026-09-02) was reviewed separately; tests were inspected but not run.

### 3. `pi-mcb`

`pi-mcb` combines derivatives of pi-vcc/pi-blackhole and observational memory behind one `session_before_compact` hook. Its source verifies the advertised unified `recall`: free-text BM25-lite/regex search over the current session file, exact `#N` expansion, file-content drill-down, branch-lineage or full-session scope, and 12-character observation/reflection provenance. Compaction is deterministic and model-free, while Observer/Reflector/Dropper memory workers call configured models.[^mcb-source]

Its main gap is the absence of a general explicit note store: observations/reflections are inferred memory, not Codex-style note files the primary model deliberately writes and edits. Search does not span separate archived Pi sessions. It warns against co-loading pi-blackhole, pi-observational-memory, or any other compactor/`recall` owner.

Compatibility needs a smoke test. The package declares only optional `@huggingface/transformers` as a peer; its development Pi dependencies are `^0.84.3`. Therefore npm will not reject Pi 0.85.1, but the author has made no Pi compatibility promise. The inspected head (`76c6f6774f7b27047d6ee769f273863f57260c94`) was newer than npm 0.2.0, so source findings may include unreleased fixes.

### 4. `pi-observational-memory`

Source confirms background Observer/Reflector/Dropper calls, durable ledger entries, proactive compaction, and a `session_before_compact` projection. It preserves source provenance and can recall exact evidence for an observation/reflection ID.[^om-source]

The README and tool contract explicitly say recall is **not semantic search or transcript browsing**. The agent must already know a specific memory ID, and lookup is confined to the current branch. It therefore satisfies durable compressed memory and rollover, but not Codex-style archived-history discovery. Wildcard Pi peers allow installation on 0.85.1 but provide weak compatibility assurance; development dependencies were `^0.81.0`.

### 5. `@pi-unipi/compactor`

This is a strong local compactor: it creates deterministic zero-LLM summaries, stores/injects resume snapshots, and offers paginated BM25/regex search over raw current-session entries that fell out of live context. It has no explicit writable note system. It also registers sandbox execution and display/tool overrides, which are unnecessary attack surface for a context-only need.[^unipi]

Do not use published 2.16.0 on Pi 0.85.1 without an upstream compatibility release: npm caret semantics make its `@earendil-works/pi-coding-agent: ^0.84.0` and TUI peer ranges stop below 0.85.0. The repository was active, tagged 2.16.0 at `9613bb9612f45530a2b0d1b411c9f031c96e1e6d`, and had about 63 stars during review.

## Other packages checked

- **`ds4-context-engine` 0.3.5:** on-paper breadth is excellent: durable pins/memory, FTS5/exact history retrieval, artifact search, proactive model-authored compaction, and native provider continuation. It is excluded from the practical shortlist because its exact peers require Pi and Pi AI **`0.84.3`**, not 0.85.1. It also replaces/registers read, edit, background-shell, provider, and persistence surfaces, so it is much broader than this need. Source: [`ae64ceea92215cc31f220431232a5bd8d4142bfc`](https://github.com/Alucard24/ds4-context-engine/tree/ae64ceea92215cc31f220431232a5bd8d4142bfc).
- **`pi-hermes-memory` 0.9.8** and **`pi-memory` 0.4.2:** useful persistent-memory/session-search packages, but neither owns the active context rollover lifecycle; pairings would still need a separate compactor and introduce ownership conflicts.
- **`pi-context` 2.1.2:** model-authored summaries/checkpoints and context navigation, but no note store or full-text raw-history recall. Assessed separately rather than duplicated here.
- **`pi-warm-memory` 0.1.0:** incompatible by design. Its peer is `@oh-my-pi/pi-coding-agent >=16.0.0`, not stock `@earendil-works/pi-coding-agent`.
- **`PyRo1121/pi-context-rollover`:** excluded because the referenced GitHub repository returned “Repository not found.”

## Safety and coexistence

All of these extensions execute inside Pi with the user's filesystem and process privileges. This was a targeted source review, not a security audit. Prefer one owner for `context`, `session_before_compact`, compaction triggers, and generically named recall tools. In particular, do not load Magic Context, pi-mcb, observational-memory, UniPi Compactor, or DS4 together unless their maintainers explicitly document coexistence.

Before adopting the recommendation, use a disposable project/session to verify: note persistence after restart; exact recovery after two reductions; branch/fork behavior; historian failure recovery; prompt-cache behavior; and collision-free operation with the existing subagent extensions.

## Sources

[^magic-readme]: CortexKit, [Magic Context README](https://github.com/cortexkit/magic-context/blob/edba4c0c9dfda8fddbcfb095c6f91d20bdbfd4c6/README.md) and [Pi package manifest](https://github.com/cortexkit/magic-context/blob/edba4c0c9dfda8fddbcfb095c6f91d20bdbfd4c6/packages/pi-plugin/package.json).

[^magic-pi]: CortexKit, Pi-specific [tool registry](https://github.com/cortexkit/magic-context/blob/edba4c0c9dfda8fddbcfb095c6f91d20bdbfd4c6/packages/pi-plugin/src/tools/index.ts), [`context` handler](https://github.com/cortexkit/magic-context/blob/edba4c0c9dfda8fddbcfb095c6f91d20bdbfd4c6/packages/pi-plugin/src/context-handler.ts), [`ctx_search`](https://github.com/cortexkit/magic-context/blob/edba4c0c9dfda8fddbcfb095c6f91d20bdbfd4c6/packages/pi-plugin/src/tools/ctx-search.ts), and [compaction ownership](https://github.com/cortexkit/magic-context/blob/edba4c0c9dfda8fddbcfb095c6f91d20bdbfd4c6/packages/pi-plugin/src/index.ts).

[^mcb-source]: Mohamed Elashri, [`pi-mcb` README](https://github.com/MohamedElashri/pi-mcb/blob/76c6f6774f7b27047d6ee769f273863f57260c94/README.md), [entry point](https://github.com/MohamedElashri/pi-mcb/blob/76c6f6774f7b27047d6ee769f273863f57260c94/index.ts), [`recall` implementation](https://github.com/MohamedElashri/pi-mcb/blob/76c6f6774f7b27047d6ee769f273863f57260c94/src/tools/recall.ts), and [package manifest](https://github.com/MohamedElashri/pi-mcb/blob/76c6f6774f7b27047d6ee769f273863f57260c94/package.json).

[^om-source]: elpapi42, [`pi-observational-memory` README](https://github.com/elpapi42/pi-observational-memory/blob/ce9fc982b3a219a7839f07c9f4a3e054e81a2b21/README.md), [compaction hook](https://github.com/elpapi42/pi-observational-memory/blob/ce9fc982b3a219a7839f07c9f4a3e054e81a2b21/src/hooks/compaction-hook.ts), [`recall` tool](https://github.com/elpapi42/pi-observational-memory/blob/ce9fc982b3a219a7839f07c9f4a3e054e81a2b21/src/tools/recall-observation.ts), and [package manifest](https://github.com/elpapi42/pi-observational-memory/blob/ce9fc982b3a219a7839f07c9f4a3e054e81a2b21/package.json).

[^unipi]: Neuron Mr White, [UniPi Compactor README](https://github.com/Neuron-Mr-White/unipi/blob/9613bb9612f45530a2b0d1b411c9f031c96e1e6d/packages/compactor/README.md), [compaction hooks](https://github.com/Neuron-Mr-White/unipi/blob/9613bb9612f45530a2b0d1b411c9f031c96e1e6d/packages/compactor/src/compaction/hooks.ts), [session recall](https://github.com/Neuron-Mr-White/unipi/blob/9613bb9612f45530a2b0d1b411c9f031c96e1e6d/packages/compactor/src/tools/vcc-recall.ts), and [package manifest](https://github.com/Neuron-Mr-White/unipi/blob/9613bb9612f45530a2b0d1b411c9f031c96e1e6d/packages/compactor/package.json).
