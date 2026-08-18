# Restore worktree paths but not Git metadata

Worktree Checkpoints restore eligible path contents and filesystem modes but never mutate the source repository's index, `HEAD`, commits, refs, stash, or current branch. This sacrifices exact staged-versus-unstaged and branch restoration so checkpoint navigation cannot silently rewrite the user's Git history or staging state; a `HEAD` mismatch is disclosed before an explicitly approved Restore writes files onto the current branch.
