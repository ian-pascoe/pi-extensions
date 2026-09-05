---
name: pi-todo
description: Diagnose Pi Todo when its tool, restored Todo List, model context, clear command, transcript rendering, or widget is missing or incorrect.
license: MIT
---

# Pi Todo

1. Read [`../../README.md`](../../README.md) for the expected tool, persistence, context, command, and widget behavior.
2. Call `todo` with `action: "list"`; classify a missing tool as an extension-loading failure.
3. Add one temporary Task, reload Pi, and list again. If it disappears, inspect the active branch for `pi-todo-state` custom entries.
4. Compare the latest valid state entry with the model's hidden Todo List context and the interactive widget, then remove the temporary Task.
5. Test `/todo clear` only after preserving any Tasks the user still needs.
6. Treat the extension as configuration-free. Finish when tool state, active-branch restoration, model context, and interactive UI agree, or one named load, session, mode, or corrupted-entry boundary explains the mismatch.
