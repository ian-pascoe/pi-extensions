# Read other sessions' Notes and History, never write them

Notes and History remain owned by one session branch, but `context_notes` and `context_history` accept a Search Scope (Branch by default, or Lineage) that reads other sessions. Reads never write: a session writes only its own journal, because a second session manager appending to another session's file would desynchronize that session's in-memory journal. A parent shares nothing by push; it reads a child's Lineage Notes live and may `copy` one into its own Notes as an unlinked snapshot, so Notes deleted with a Child Agent survive only where copied.

Other sessions are read as their latest branch, parsed from file contents without `SessionManager.open`, which can migrate and rewrite files; a partial final line from a live session is ignored, and a session file that is gone or unreadable is skipped. The Lineage scope reads the Root Agent's session folder, ancestors nearest first and then descendants newest first; searches page with `next_offset` and build no index, consistent with deriving state from Pi sessions.

Scopes wider than an agent tree (sessions of the same repository, or every session Pi keeps) were considered and deferred: they would need repository identity that Pi does not record, and would couple this package to Pi's session folder layout. The Note Index lists only the agent's own Notes.
