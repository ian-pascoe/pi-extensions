---
"@ian-pascoe/pi-todo": minor
---

A tool group that changes the Todo List now projects one hidden Todo List snapshot of its final state instead of one full snapshot per mutation, at the same position after the group's sibling results. Ten `todo` calls in one `codemode` script used to inject ten complete copies of the list into context, and a routine "complete #5, start #6" cost two; each now costs one, and a group that ends in the state it began with adds none. Snapshots from separate tool groups and the post-compaction baseline behave as before. Each snapshot now starts with `Todo List state from the pi-todo extension (not a user message):` instead of `Todo List:`, so it no longer reads like a user-authored message. Snapshots are projected from the session's state entries on every request, so a resumed session shows its older tool groups with the new header and one snapshot each; that changes the prompt-cache prefix once for sessions started before the upgrade.
