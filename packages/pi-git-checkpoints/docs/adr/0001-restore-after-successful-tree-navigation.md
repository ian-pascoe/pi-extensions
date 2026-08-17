# Restore only after successful tree navigation

Pi runs `session_before_tree` handlers in extension order, so a later extension can cancel navigation after Git Checkpoints has received approval. Git Checkpoints therefore records Restore intent before navigation but performs the Restore during `session_tree`, avoiding a restored worktree with an unchanged conversation leaf at the cost that Restore failure cannot cancel completed navigation; Safety Checkpoint rollback protects the worktree instead.
