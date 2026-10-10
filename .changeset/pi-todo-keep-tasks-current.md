---
"@ian-pascoe/pi-todo": patch
---

Agents now keep the Todo List current, including across compaction. Previously nothing told the agent to update Tasks. After a compaction or Rollover the list showed up only as plain state right after the summary, and a Handoff's own "next actions" quietly took its place, so Tasks could stay `pending` for the rest of the session. Two changes fix this:

- `todo` now has a `promptSnippet` and a guideline in Pi's default system prompt: when the Todo List has Tasks, mark a Task active when you start it and completed as soon as it is done, and bring the list up to date before context is compacted. The text never changes, so it does not move the prompt-cache prefix within a session. Sessions started before the upgrade change it once.
- When compaction leaves unfinished Tasks, a Checkpoint Snapshot after the retained Tail repeats the list and asks the agent to reconcile it with the work already done before continuing. The Snapshot is built from saved session entries at a fixed position, so prefixes written after the checkpoint stay byte-identical.
