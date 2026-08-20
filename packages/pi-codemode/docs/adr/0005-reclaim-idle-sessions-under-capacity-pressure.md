# Reclaim idle Sessions under capacity pressure

When a new CodeMode Session reaches `maxSessions`, CodeMode gracefully stops
the least-recently-used idle Session before starting the replacement. Running
Sessions are never reclaimed; admission still fails when every live Session is
running.

Session Reclamation destroys the reclaimed Session's Notebook Bindings, so the
new execution reports its ID and later polling retains an `eviction` result.
Executing or polling a Session refreshes recency; listing and Observer rendering
do not. This pressure-only policy keeps `maxSessions` a hard process budget
without adding timers or expiring Sessions while capacity remains available.
