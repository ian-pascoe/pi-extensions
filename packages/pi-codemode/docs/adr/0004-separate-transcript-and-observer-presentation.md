# Separate durable Transcript and ephemeral Observer presentation

CodeMode presents activity through two read-only surfaces. The CodeMode
Transcript is durable conversation history reconstructed from bounded,
versioned Presentation Snapshots retained in tool-result details, plus human-only
custom entries containing bounded native nested-tool replay data. Each Cell's
custom entry is appended once at settlement, in invocation order; polling does
not append it again. Background completion uses the current Transcript tail
with explicit Session and Cell Ordinal attribution. Waited results carry only an
opaque reference in their Presentation Snapshot; their native renderer resolves
that reference from the custom entry and renders beneath the owning Cell, even
when Pi has precreated later outer tool rows. The custom entry stays hidden while
that live or retained owner exists, and falls back to the tail when history no
longer contains the owner. Replay never executes a tool
or recomputes an edit preview from the filesystem. Unfinished calls retain an
unknown outcome, and stale branch or Pi-session callbacks cannot rewrite or
reattribute a settled display. Oversized data uses a marked bounded fallback;
full Result Spills remain live-session files, not durable history.

The CodeMode Observer UI is an ephemeral TUI projection of current coordinator state and may
disappear after an idle cooldown.

`AgentToolResult.content` remains the exact CodeMode result JSON returned to the
model. Presentation Snapshots, Result Spill paths, widgets, and partial progress
never replace or summarize that model-facing text. The
Observer consumes coordinator facts but sends no Cell, Session, or registered
tool operation and offers no human controls.

This separation duplicates a small bounded state projection, but it keeps model
behavior independent from human presentation, makes transcript replay useful,
and prevents a TUI lifecycle failure from becoming CodeMode execution policy.
