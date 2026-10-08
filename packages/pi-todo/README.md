# Pi Todo

`@ian-pascoe/pi-todo` gives Pi agents a minimal, session-native **Todo List** without imposing a planning workflow.

Requires Node `>=22.19.0` and Pi `>=1.1.0`.

## Install

```bash
pi install npm:@ian-pascoe/pi-todo
# or from this checkout
pi -e ./src/index.ts
```

## Tool

The `todo` tool supports five actions:

| Action   | Input                                                 | Result                            |
| -------- | ----------------------------------------------------- | --------------------------------- |
| `list`   | —                                                     | Lists every Task                  |
| `add`    | `title`, optional `description` and `status`          | Adds a Task                       |
| `add`    | `tasks: [{ title, description? }]`, optional `status` | Adds several Tasks at once        |
| `update` | `id`, plus fields to change                           | Updates a Task                    |
| `update` | `updates: [{ id, status?, title?, description? }]`    | Updates several Tasks at once     |
| `remove` | `id`                                                  | Removes one Task                  |
| `clear`  | —                                                     | Removes every Task and resets IDs |

A batch `add` creates every Task in `tasks` atomically, with sequential IDs, and the result lists them. It writes one `pi-todo-state` session entry, so the tool group that made it projects a single Todo List Snapshot. If any title or description is empty, or the Task IDs would run out, it creates no Task. `tasks` must hold at least one entry and replaces `title`/`description`: a request that gives both `tasks` and `title` or a non-null `description` is rejected rather than guessed at. Per-Task fields other than `title` and `description` are rejected too. A top-level `status` applies to every new Task.

A batch `update` changes every Task in `updates` atomically and the result lists them in request order. It writes one `pi-todo-state` session entry, so the tool group that made it projects a single Todo List Snapshot. If any ID is unknown or repeated, any title or description is empty, or any entry provides no title, description, or status, it changes no Task. `updates` must hold at least one entry and replaces `id`, `title`, `description`, and `status`: a request that gives both `updates` and any of those (a `null` description counts as absent) is rejected rather than guessed at. Per-Task fields other than `id`, `status`, `title`, and `description` are rejected too.

A Pi `codemode` script receives the result as an object (the tool declares an `outputSchema`) instead of the text (its field names are already single words, so they match Pi's snake_case convention); the model still reads the same text, and failures still throw:

| Action           | Script value                                                                 |
| ---------------- | ---------------------------------------------------------------------------- |
| `list`           | `{ action: "list", tasks }`, each Task `{ id, title, description?, status }` |
| `add` / `update` | `{ action, task }` with the resulting Task                                   |
| batch `add`      | `{ action: "add", tasks }` with the created Tasks in ID order                |
| batch `update`   | `{ action: "update", tasks }` with the changed Tasks in request order        |
| `remove`         | `{ action: "remove", id }`                                                   |
| `clear`          | `{ action: "clear", cleared }` with the number of Tasks removed              |

Task status is `pending`, `active`, or `completed`; `add` defaults to `pending`. Tasks are flat, duplicate titles are allowed, and multiple Tasks may be active. Set `description` to `null` during `update` to remove it.

Each tool group that changes the Todo List is projected from the immutable session state entries as one hidden full **Todo List Snapshot** of the group's final state, at a fixed conversation position after all of the group's sibling results. A tool group is one assistant turn's tool calls, including several `todo` calls inside one `codemode` script, so ten calls in a script add one Todo List Snapshot, not ten. A group that ends in the state it began with adds none. A change made outside a tool group, such as `/todo clear`, still projects its own Todo List Snapshot right away. Each Todo List Snapshot starts with the header `Todo List state from the pi-todo extension (not a user message):` so it does not read like user input. Later requests keep earlier Todo List Snapshots in place. Clearing the list produces an explicit empty Todo List Snapshot. The system prompt and tool description do not change.

After compaction, a fixed baseline immediately after the summary restores the state from before the retained Tail. Retained and newer tool groups follow chronologically. This preserves previously written conversation cache prefixes between checkpoints; it does not guarantee provider cache hits.

`todo` declares MCP-style `annotations`: not read-only, but non-destructive (it only appends to the session's own journal), not idempotent, and closed-world. Pi reports them through `pi.getAllTools()` for permission extensions and does not send them to model providers.

## UI and persistence

In interactive mode, a compact widget above the editor shows status counts and up to five Tasks. Tool calls and results use custom transcript rendering. `/todo clear` confirms before manually clearing the list.

State is stored only in `pi-todo-state` session entries, without a second message journal. It follows the active session branch and survives reloads, restarts, and compaction. Legacy state entries use the same projection. The package has no settings or external state.

A failed journal write leaves acknowledged Todo state unchanged and disables Todo in that loaded session, including across `/reload`. Pi has an existing persistence limitation: subsequent entries can reference the unwritten entry, so reopening may omit earlier history from the selected branch even though it remains in the file. Todo does not repair session history; recovery is outside this cache-prefix change.

Missing or ambiguous conversation anchors abort the request instead of silently relocating Todo List Snapshots. Extensions that rewrite those anchors are unsupported.

This is privileged extension code: review it before installing it into an agent that can access local files, tools, or credentials.
