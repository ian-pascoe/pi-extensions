# Pi Git Status Widget

`@ian-pascoe/pi-git-status-widget` displays a Git **Worktree Snapshot** in Pi's UI.

Requires Node `>=22.19.0` and Pi `>=0.84.1`.

## Install

```bash
pi install npm:@ian-pascoe/pi-git-status-widget
# or from this checkout
pi -e ./src/index.ts
```

The widget shows the branch plus ahead, behind, conflicted, untracked, and modified counts. A clean worktree shows a success indicator. A **Widget Refresh** runs at session start, after input and tool execution, and every two seconds. Git failures and non-worktree directories hide the widget.

`git` must be available on `PATH`. The extension intentionally permits overlapping polling and in-flight Git processes to preserve the lightweight current behavior.

This is privileged extension code: review it before installing it into an agent that can access local files, tools, or credentials.
