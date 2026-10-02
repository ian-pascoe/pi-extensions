---
"@ian-pascoe/pi-advisor": minor
---

Replace the Advisor's JSON dumps with readable TUI rendering and add a settings menu:

- In the interactive TUI, `/advisor` alone opens a settings menu built from Pi's native settings list, like `/settings`. It shows the live Advisor state, writes edits immediately to the selected scope (session, trusted project, or global), edits the prompt in Pi's own editor component, and offers Resume while paused. Closing it records one status entry listing the changes. Without the TUI, `/advisor` records status as before; `/advisor status` always does.
- Status entries show a compact summary (state, model, backlog, usage and cost, unavailable tools, last error), with every setting, its source, and each Child Agent when expanded. Entries from configuration changes lead with the changes they applied, such as `✓ model → provider/id [session]`.
- Interventions render with severity styling and Advisor attribution, and Child Agent findings carry the child's label. Long Nits collapse; Concerns and Blockers always show in full.
- `advisor_ask` shows its question and a Markdown answer preview.
- An enabled Advisor shows its state and Review Backlog in the footer.
- `/advisor set` with an unknown key now reports `Unknown Advisor option: <key>`.

Rendering is UI-only: model-visible Intervention content, tool declarations, and the system prompt are unchanged. Older status entries keep their state and error.
