# Separate durable Transcript and ephemeral Observer presentation

CodeMode presents activity through two read-only surfaces. The CodeMode
Transcript is durable conversation history reconstructed from bounded,
versioned Presentation Snapshots retained in tool-result details. The CodeMode
Observer UI is an ephemeral TUI projection of current coordinator state and may
disappear after an idle cooldown.

`AgentToolResult.content` remains the exact CodeMode result JSON returned to the
model. Presentation Snapshots, Result Spill paths, widgets, and partial progress
never replace or summarize that model-facing text. The
Observer consumes coordinator facts but sends no Cell, Session, or registered
tool operation and offers no human controls.

This separation duplicates a small bounded state projection, but it keeps model
behavior independent from human presentation, makes transcript replay useful,
and prevents a TUI lifecycle failure from becoming CodeMode execution policy.
