---
"@ian-pascoe/pi-advisor": minor
---

Replace the Advisor's JSON dumps with readable TUI rendering:

- `/advisor` status entries show a compact summary (state, model, backlog, usage and cost, unavailable tools, last error), with every setting, its source, and each Child Agent when expanded. Mutating commands lead with the change they applied, such as `✓ model → provider/id [session]`.
- Interventions render with severity styling and Advisor attribution, and Child Agent findings carry the child's label. Long Nits collapse; Concerns and Blockers always show in full.
- `advisor_ask` shows its question and a Markdown answer preview.
- An enabled Advisor shows its state and Review Backlog in the footer.

Rendering is UI-only: model-visible Intervention content, tool declarations, and the system prompt are unchanged. Older status entries keep their state and error.
