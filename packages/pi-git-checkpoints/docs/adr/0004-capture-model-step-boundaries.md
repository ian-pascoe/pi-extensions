# Capture Model Step boundaries

Git Checkpoints captures before and after each Model Step, defined as one LLM response plus its complete tool batch. Pi may execute tools concurrently and persists their results only after the batch, so parallel results share the final Worktree Checkpoint rather than claiming nonexistent per-tool filesystem ordering; user `!` and `!!` commands become part of the next Model Step baseline because Pi exposes no composable post-execution hook.
