---
"@ian-pascoe/pi-minimal-subagents": minor
---

Fix rough edges found by using the coordinator tools:

- **Behavior change:** `session_context` now defaults to `omit`, so a new child starts without the parent's conversation. Pass `session_context: "inherit"` (or `"compact"`) to keep the previous behavior. Inheriting copied the whole parent conversation without prompt-cache reuse and let children mistake the parent's requests for their own. The `task` and `session_context` descriptions now ask for a self-contained brief and explain the trade-off. Existing Child Agents keep the mode recorded in their Launch Contracts.

- A child that inherits or compacts its parent's conversation now receives it quoted, as one user-role `minimal-subagents.parent-context` message per parent message, instead of replaying the parent's assistant turns as its own. Tool calls and results become text, custom messages keep their `customType` in the label, incomplete (errored, aborted, or length-limited) parent turns are marked, and images are kept. Parent reasoning, system prompt, and tool declarations are omitted. Its task follows as an explicit handoff. This keeps the parent's turns distinct from the child's own, rather than guaranteeing that a child ignores the quoted requests. The Launch Contract still records the unframed task.
- `subagent` runs sequentially, so a `subagent_wait` or `agent_message` in the same tool batch can target the new child instead of failing with `unknown agent`.
- `subagent` returns a compact result: `agent_id`, `turn_id`, `status`, the resolved `model`, `thinking_level`, `tools`, and `delegation`, plus any tool-resolution `warnings`. The full Child Agent detail remains available through `subagent_status` and the transcript renderer.
- `agent_message` to an idle child reports `disposition: "started-turn"` with the new `turn_id` to wait on, instead of `queued`. Tool descriptions explain how to continue an idle child.
- The Root Agent can inspect any descendant with `subagent_status`. Model-facing status no longer reports an empty `children` array next to a non-zero `child_count`.
- `subagent_cancel` lists in `affected_agent_ids` only agents whose active turns it cancelled.
- Reported `usage` always includes `cacheWrite1h` and `reasoning`.
- Clearer errors: an unavailable tool lists the permitted ordinary tools, an unknown `turn_id` suggests omitting it, and reusing a deleted agent ID asks for a different `agent_id`.
- Coordinator tool rendering shows content without expanding: a `subagent` call shows its launch settings and task, a waiting `subagent_wait` shows the child's tool-call count and its latest work on a tree rail, rendered with Pi's own message and tool components, a settled wait previews the child's output (or error) with cost, and automatic agent results preview as Markdown. Long text shows its first 10 lines; Pi's tool-expansion key shows the rest.
- The `/subagents` panel keeps its background behind truncated lines, including the ellipsis, padding, and border.
