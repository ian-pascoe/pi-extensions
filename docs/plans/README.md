# Implementation plans

## Prompt-cache audit follow-up

Seven implementation handoffs from the extension audit at `127e85a` (2026-09-09). **These are plans, not implemented fixes.** Each defines its scope, regression tests, verification commands, and stop conditions. Use the installed local binaries specified in each plan; do not trigger dependency installation or reference-repository synchronization incidentally.

| Plan                                                                                                               | Priority | Dependencies                                                | Status                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------ | -------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [001 — Preserve Todo conversation-cache prefixes](001-preserve-todo-cache-prefix.md)                               | P1       | None; coordinate Context Management test ownership with 002 | DONE — immutable journal projections preserve serialized cache prefixes; 120 tests, typechecks, lint/format, and two-axis review pass. Pre-existing host write-failure recovery explicitly deferred; no upstream changes. |
| [002 — Let Pi own compaction policy](002-correct-context-budget-accounting.md)                                     | P1       | None                                                        | DONE — Pi owns compaction policy; fresh preparation and overflow recovery verified. 131 package tests plus 15 Todo tests, typechecks, lint/format, and two-axis review pass.                                              |
| [003 — Preserve active-tool order](003-preserve-active-tool-order.md)                                              | P1       | None                                                        | DONE — 79 focused tests and 1,069 workspace tests pass; all 3 typechecks, lint/format, and both review axes pass.                                                                                                         |
| [004 — Stabilize CodeMode's execute description](004-stabilize-codemode-tool-description.md)                       | P2       | 003                                                         | DONE — 157 CodeMode tests and 1,071 workspace tests pass; offline provider serialization, typecheck, lint/format, and both review axes pass.                                                                              |
| [005 — Stabilize MCP instruction snapshots](005-stabilize-mcp-instruction-snapshots.md)                            | P2       | 003 and 004 for combined verification                       | DONE — roster-free Server Instructions retain the agent-start boundary; 237 MCP tests and 1,080 workspace tests pass, with offline direct/CodeMode serialization, typecheck, lint/format, and both review axes passing.   |
| [006 — Preserve budget-warning conversation-cache prefixes](006-preserve-budget-warning-cache-prefix.md)           | P2       | 001 and 002; explicit first-request policy                  | SUPERSEDED by 002's approved removal of custom budget warnings                                                                                                                                                            |
| [007 — Remove calendar year from Web Search's schema metadata](007-remove-calendar-year-from-web-search-schema.md) | P3       | None                                                        | TODO                                                                                                                                                                                                                      |

### Execution order

Start 001, 002, 003, and 007 independently. Coordinate shared Context Management test files between 001 and 002. Follow 003 with 004, then 005. Plan 006 is superseded by 002's removal of custom budget warnings. Each implementer owns only the files named in their plan; one coordinator should update this index when work runs concurrently.

001 requires an offline lifecycle proof before choosing a durable context-delivery implementation. 002's latest approved scope removes competing extension accounting and delegates triggers/retention to Pi; normal compaction requests fresh Notes/Handoff, with saved-state fallback only for actual overflow. Its native-only scope supersedes the earlier arithmetic fix and 006's custom warning-delivery work. A failed proof is a design blocker, not permission to mutate Pi's journal or replay completed tools. 004 intentionally trades inline declarations for existing live discovery; its README/ADR update is part of the change.

### What the audit established

- Offline request serialization reproduced transient Todo context replacing previously cacheable conversation content. A one-shot budget warning has the same smaller, less frequent lifetime issue.
- Shared budget accounting adds standing-context estimates to usage-backed totals that already include them, causing premature native checkpoints in the reproduced large-prompt case.
- Equal catalogue refreshes and redundant Subagent Access enablement can reorder existing active tools.
- CodeMode embeds a live catalogue in an existing execute description; MCP includes a redundant tool roster in system instructions.
- Web Search's year changes at module load across calendar years, not on each turn. This is low-impact hygiene.

The audit's targeted baseline passed **152 tests across 13 files**. Offline reproductions show prefix/accounting behavior, not paid-provider cache-hit measurements or an estimated savings percentage. Implementers must establish fresh baselines and run their plan's new regressions.

### Keep these distinctions

Do not freeze authorization, hide real schema changes, alter routing/session IDs, or share child identity to chase cache reuse. Native Rollover is an intentional prefix replacement; 002 prevents unnecessary transitions, not legitimate safety recovery. Fresh object allocation with identical serialized content is not itself a cache defect. Supported native deferred additions can preserve an existing prefix; not every tool addition is a cache bust.

No separate change is planned for UI-only Bible/TPS/Git-checkpoint updates, checkpoint bookkeeping, static DAP definitions, Skills Selector input handling, or newly appended Formatter/LSP/tool results. Those did not establish harmful rewriting of earlier model-visible content. Child-specific identity may limit cross-child reuse, but isolation remains unchanged without evidence supporting a safe improvement.

Provider background: [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching), and [Gemini context caching](https://ai.google.dev/gemini-api/docs/caching). The concrete regression gates target the installed Pi implementation rather than assuming identical provider behavior.

## Other plans

- [Pi Skills Selector](pi-skills-selector.md) — existing plan, unchanged by this audit.
