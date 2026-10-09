# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`GLOSSARY-MAP.md`** at the repo root: it points at one `GLOSSARY.md` per package context. Read each one relevant to the topic.
- **`docs/adr/`**: read ADRs that affect the whole repository.
- **`packages/<package>/docs/adr/`**: read package-scoped ADRs that touch the area you're about to work in.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill creates them lazily when terms or decisions actually get resolved.

## File structure

This repo uses a multi-context layout (presence of `GLOSSARY-MAP.md` at the root):

```text
/
├── GLOSSARY-MAP.md
├── docs/adr/                          ← repository-wide decisions
└── packages/
    ├── first-package/
    │   ├── GLOSSARY.md
    │   └── docs/adr/                  ← package-specific decisions
    └── second-package/
        ├── GLOSSARY.md
        └── docs/adr/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in the relevant `GLOSSARY.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders), but worth reopening because…_
