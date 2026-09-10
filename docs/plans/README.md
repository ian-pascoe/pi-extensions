# Implementation plans

## Prompt-cache audit follow-up

Seven implementation handoffs from the extension audit at `127e85a` (2026-09-09). **These are plans, not implemented fixes.** Each defines its scope, regression tests, verification commands, and stop conditions. Use the installed local binaries specified in each plan; do not trigger dependency installation or reference-repository synchronization incidentally.

| Plan                                                                                                               | Priority | Dependencies                                                | Status                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------ | -------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [001 — Preserve Todo conversation-cache prefixes](001-preserve-todo-cache-prefix.md)                               | P1       | None; coordinate Context Management test ownership with 002 | DONE — immutable journal projections preserve serialized cache prefixes; 120 tests, typechecks, lint/format, and two-axis review pass. Pre-existing host write-failure recovery explicitly deferred; no upstream changes. |
| [002 — Correct context-budget accounting](002-correct-context-budget-accounting.md)                                | P1       | None                                                        | TODO                                                                                                                                                                                                                      |
| [003 — Preserve active-tool order](003-preserve-active-tool-order.md)                                              | P1       | None                                                        | TODO                                                                                                                                                                                                                      |
| [004 — Stabilize CodeMode's execute description](004-stabilize-codemode-tool-description.md)                       | P2       | 003                                                         | TODO                                                                                                                                                                                                                      |
| [005 — Stabilize MCP instruction snapshots](005-stabilize-mcp-instruction-snapshots.md)                            | P2       | 003 and 004 for combined verification                       | TODO                                                                                                                                                                                                                      |
| [006 — Preserve budget-warning conversation-cache prefixes](006-preserve-budget-warning-cache-prefix.md)           | P2       | 001 and 002; explicit first-request policy                  | BLOCKED — policy decision                                                                                                                                                                                                 |
| [007 — Remove calendar year from Web Search's schema metadata](007-remove-calendar-year-from-web-search-schema.md) | P3       | None                                                        | TODO                                                                                                                                                                                                                      |

### Execution order

Start 001, 002, 003, and 007 independently. Coordinate shared Context Management test files between 001 and 002. Follow 003 with 004, then 005; follow 001 and 002 with 006. Each implementer owns only the files named in their plan; one coordinator should update this index when work runs concurrently.

001 requires an offline lifecycle proof before choosing a durable context-delivery implementation. 002 requires proven request/usage provenance before reducing standing-context reservations. 006 is blocked on an explicit first-request policy: immediate durable warnings conflict with Pi's deferred initial journal flush; it must not reject previously valid prompts or silently weaken persistence. A failed proof is a design blocker, not permission to mutate Pi's journal or replay completed tools. 004 intentionally trades inline declarations for existing live discovery; its README/ADR update is part of the change.

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
