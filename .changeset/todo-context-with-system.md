---
"@ian-pascoe/pi-todo": patch
---

Project Todo List Snapshots on Pi's `context_with_system` event, so a system prompt change after a Snapshot, such as moving a session to another worktree, no longer restarts the prompt cache from the first message. A Snapshot with no anchor now follows the leading system message.
