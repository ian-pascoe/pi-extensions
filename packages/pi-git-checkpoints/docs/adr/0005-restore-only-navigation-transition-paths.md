# Restore only Navigation Transition paths

Backward, forward, and sideways Navigation Transitions restore only paths changed between the current and target positions, writing their Target Checkpoint contents after explicit approval while preserving unrelated worktree changes. A live-state comparison immediately before Restore rejects stale approval, preferring an unchanged worktree and completed conversation navigation over silently overwriting changes made after the prompt.
