# Git Checkpoints context

Git Checkpoints relates Pi conversation positions to explicitly restorable worktree states.

## Language

**Worktree Checkpoint**:
The restorable contents and filesystem modes of checkpoint-eligible paths associated with a Pi session position. It excludes the source repository's index, `HEAD`, commits, refs, stash, and current branch.
_Avoid_: Snapshot, Git stash

**Model Step**:
One LLM response together with its complete tool batch. Parallel tool results in the same Model Step share one resulting Worktree Checkpoint.

**Navigation Transition**:
Movement from the current session-tree leaf to a target leaf in any direction.

**Target Checkpoint**:
The Worktree Checkpoint associated with the resulting position of a Navigation Transition.

**Abandoned Segment**:
The session entries between the old leaf and its common ancestor with a backward or sideways navigation target.

**Restore**:
An explicitly approved replacement of affected paths with their Target Checkpoint contents.
_Avoid_: Revert

**Safety Checkpoint**:
The restorable state captured immediately before a Restore so that Restore can be undone.
