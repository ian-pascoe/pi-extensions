# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT-MAP.md`** at the repo root — it points to one `CONTEXT.md` per relevant package.
- **`docs/adr/`** — read ADRs that affect the whole repository.
- **`packages/<package>/CONTEXT.md`** — read each package context relevant to the topic.
- **`packages/<package>/docs/adr/`** — read package-scoped ADRs that touch the area about to be changed.

If any of these files don't exist, **proceed silently**. The `/domain-modeling` skill creates them lazily when terms or decisions are resolved.

## File structure

This repo uses a multi-context layout:

```text
/
├── CONTEXT-MAP.md
├── docs/adr/                          ← repository-wide decisions
└── packages/
    ├── first-package/
    │   ├── CONTEXT.md
    │   └── docs/adr/                  ← package-specific decisions
    └── second-package/
        ├── CONTEXT.md
        └── docs/adr/
```

## Use the glossary's vocabulary

When output names a domain concept—in an issue title, refactor proposal, hypothesis, or test name—use the term defined in the relevant `CONTEXT.md`. Avoid synonyms that its glossary explicitly rejects.

If a needed concept isn't in the glossary, reconsider whether the language belongs to the project or note the gap for `/domain-modeling`.

## Flag ADR conflicts

If output contradicts an existing ADR, surface the conflict explicitly rather than silently overriding it:

> _Contradicts ADR-0007 (event-sourced orders)—but worth reopening because…_
