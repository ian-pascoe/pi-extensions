---
"@ian-pascoe/pi-context-management": minor
---

Search the Notes and History of other sessions in the same git repository, or of every session Pi keeps. `context_notes` `list`/`search` and `context_history` `search` accept `scope: "repository"`, covering every session whose folder is in this session's repository through any worktree, and `scope: "all"`, both newest session first and labelled by agent and session; refs from any scoped result work with `read` and `copy`. Each session now records its repository once when it starts, so sessions from a removed worktree stay in the repository scope; older sessions are matched through their folder.
