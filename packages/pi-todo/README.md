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

Each changed Todo List is projected from its immutable session state entry as a hidden full snapshot at a fixed conversation position. Mutations inside a tool group appear after all sibling results; later requests keep earlier snapshots in place. Clearing the list produces an explicit empty snapshot. The system prompt and tool description do not change.

After compaction, a fixed baseline immediately after the summary restores the state from before the retained Tail. Retained and newer mutations follow chronologically. This preserves previously written conversation cache prefixes between checkpoints; it does not guarantee provider cache hits.

## UI and persistence

In interactive mode, a compact widget above the editor shows status counts and up to five Tasks. Tool calls and results use custom transcript rendering. `/todo clear` confirms before manually clearing the list.

State is stored only in `pi-todo-state` session entries, without a second message journal. It follows the active session branch and survives reloads, restarts, and compaction. Legacy state entries use the same projection. The package has no settings or external state.

A failed journal write leaves acknowledged Todo state unchanged and disables Todo in that loaded session, including across `/reload`. Pi has an existing persistence limitation: subsequent entries can reference the unwritten entry, so reopening may omit earlier history from the selected branch even though it remains in the file. Todo does not repair session history; recovery is outside this cache-prefix change.

Missing or ambiguous conversation anchors abort the request instead of silently relocating snapshots. Extensions that rewrite those anchors are unsupported.

This is privileged extension code: review it before installing it into an agent that can access local files, tools, or credentials.
