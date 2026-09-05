# Pi Todo

`@ian-pascoe/pi-todo` gives Pi agents a minimal, session-native **Todo List** without imposing a planning workflow.

Requires Node `>=22.19.0` and Pi `>=0.84.1`.

## Install

```bash
pi install npm:@ian-pascoe/pi-todo
# or from this checkout
pi -e ./src/index.ts
```

## Tool

The `todo` tool supports five actions:

| Action   | Input                                        | Result                            |
| -------- | -------------------------------------------- | --------------------------------- |
| `list`   | —                                            | Lists every Task                  |
| `add`    | `title`, optional `description` and `status` | Adds a Task                       |
| `update` | `id`, plus fields to change                  | Updates a Task                    |
| `remove` | `id`                                         | Removes one Task                  |
| `clear`  | —                                            | Removes every Task and resets IDs |

Task status is `pending`, `active`, or `completed`; `add` defaults to `pending`. Tasks are flat, duplicate titles are allowed, and multiple Tasks may be active. Set `description` to `null` during `update` to remove it.

The extension appends the current Todo List as hidden tail context before each model request. It does not modify the system prompt or tool description as the list changes, preserving the cacheable prompt prefix.

## UI and persistence

In interactive mode, a compact widget above the editor shows status counts and up to five Tasks. Tool calls and results use custom transcript rendering. `/todo clear` confirms before manually clearing the list.

State is stored only in Pi session entries. It follows the active session branch and survives reloads, restarts, and compaction. The package has no settings or external state.

This is privileged extension code: review it before installing it into an agent that can access local files, tools, or credentials.
