---
name: pi-skills-selector
description: Diagnose Pi Skills Selector when autocomplete is missing or a Skill Reference converts to a missing or wrong document link.
license: MIT
---

# Pi Skills Selector

1. Read [`../../README.md`](../../README.md) for the reference syntax and integration boundaries.
2. For missing autocomplete, confirm extension loading and interactive mode, then try bare `$` in ordinary prose. Compare the expected Skill with Pi's discovered resources; finish when the native popup lists it or a named loading/resource boundary explains its absence.
3. For missing or wrong conversion, compare a typed reference with its submitted user message and Pi's winning Skill document path. Check exact spelling and literal contexts. Finish when the link targets that document or a named catalogue/input boundary explains the mismatch.
4. If the link is correct but the model did not read it, report conversion as working: the model controls document reads. Keep this extension configuration-free.
