---
"pi-byterover": patch
---

Replace the `zod` dependency with TypeBox (already a peer dependency) for Byterover configuration parsing. Validation outcomes, defaults, and loader behavior are unchanged; unknown configuration keys are now rejected instead of silently stripped.
