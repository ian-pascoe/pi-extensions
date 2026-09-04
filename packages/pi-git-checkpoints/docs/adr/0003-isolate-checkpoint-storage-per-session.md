# Isolate checkpoint storage per Pi session

Each Pi session uses a separate Git store under Pi's agent directory, keyed by canonical workspace and session identity. Repository mode seeds the store from the source index and object database; standalone mode starts with an empty store keyed by the canonical starting directory. This avoids modifying the user's index or stash, creates no checkpoint metadata in standalone workspaces, and prevents concurrent Pi processes from sharing a mutable checkpoint index, at the cost of duplicated session-local objects bounded by configurable inactivity retention.

Small, versioned Restore undo records live in branch-scoped Pi session entries and reference trees in that private Git store. Successful undo appends a consumed tombstone. On upgrade, a valid legacy `undo.json` record is imported into the active branch once and the obsolete file is removed.
