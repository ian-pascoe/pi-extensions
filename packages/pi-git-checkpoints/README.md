# Git Checkpoints for Pi

Git Checkpoints records Git-backed **Worktree Checkpoints** at Pi Model Step boundaries and can Restore affected files when `/tree` moves backward, forward, or sideways.

It requires Node.js 22.19 or newer and the `git` executable on `PATH`. The starting directory does not need to be a Git repository.

## Install

```bash
pi install npm:@ian-pascoe/pi-git-checkpoints
```

## How it works

- A Model Step is one model response and its complete tool batch. Git Checkpoints captures before and after every Model Step; parallel tool results share the final checkpoint.
- In a repository, checkpoints are scoped to Pi's starting directory and seeded from the source index and object database.
- Outside a repository, Git Checkpoints starts an empty private index scoped to the canonical starting directory. It never creates `.git` or other checkpoint metadata there.
- `/tree` considers only paths changed along the Navigation Transition. Unrelated working files are preserved.
- In TUI and RPC modes, a change preview offers **Restore code and navigate**, **Keep code and navigate**, or **Cancel navigation**. Print and JSON modes always keep files unchanged.
- Restore runs only after conversation navigation succeeds. A last-moment capture prevents stale approval from overwriting newer edits.

Git Checkpoints never restores or modifies a source repository's index, `HEAD`, commits, refs, stash, current branch, or staged state. When the current repository `HEAD` differs from a checkpoint, the Restore prompt warns but does not switch branches. Standalone mode has no `HEAD` warning.

User `!` and `!!` changes enter the next Model Step baseline because Pi exposes no composable post-user-bash hook.

## Commands

```text
/checkpoint
/checkpoint status
/checkpoint undo
```

`status` reports repository, standalone, or disabled state; valid Model Step count; private store path; retention; the last capture failure; and undo availability. Bare `/checkpoint` adds concise usage.

`undo` restores the Safety Checkpoint from the most recent successful Restore. If affected paths have changed since that Restore, TUI/RPC asks for confirmation; print and JSON modes refuse the divergent undo. A later successful Restore replaces the previous undo record, and successful undo removes it.

## Eligible paths

Repository mode includes tracked files regardless of size and nonignored untracked files up to 2 MiB. Standalone mode initially treats every path as untracked, so the same 2-MiB limit applies on the first successful capture; captured paths then behave as private-index tracked files even after growth.

Regular files, deletions, symbolic links, and executable modes are supported. Ignored paths, oversized untracked paths, submodules, nested repositories, sockets, devices, and unsupported entries remain untouched and are reported as skipped. Git Checkpoints rejects lexical path escapes and destinations whose existing ancestors escape through symbolic links.

## Settings

The default retention is seven days:

```json
{
  "gitCheckpoints": {
    "retentionDays": 7
  }
}
```

`retentionDays` must be a positive safe integer. A trusted project `.pi/settings.json` value replaces the global `~/.pi/agent/settings.json` value. Invalid or unknown values warn once and fall back to a valid global value or the default. Settings reload only on session start, including `/reload`.

Each session has an isolated store at:

```text
<agent-dir>/git-checkpoints/<workspace-id>/<session-id>/
```

Expired inactive stores are removed asynchronously. Cleanup failures never block capture or Restore.

## Failure behavior

A capture failure disables checkpointing for the session until `/reload` or the next session. Restore first records a Safety Checkpoint; if writing fails, Git Checkpoints attempts to recover every affected path and reports exact unrecovered paths. It cannot roll back changes outside the approved Navigation Transition paths.
