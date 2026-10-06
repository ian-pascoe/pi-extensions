# @ian-pascoe/pi-todo

## 0.4.0

### Minor Changes

- 6aff6f2: The `todo` tool's `add` action now accepts `tasks: [{ title, description? }]` to create several Tasks atomically in one call.

## 0.3.0

### Minor Changes

- 89311d8: A tool group that changes the Todo List now projects one hidden Todo List Snapshot of its final state instead of one full Todo List Snapshot per mutation, at the same position after the group's sibling results. Ten `todo` calls in one `codemode` script used to inject ten complete copies of the list into context, and a routine "complete #5, start #6" cost two; each now costs one, and a group that ends in the state it began with adds none. Todo List Snapshots from separate tool groups and the post-compaction baseline behave as before. Each Todo List Snapshot now starts with `Todo List state from the pi-todo extension (not a user message):` instead of `Todo List:`, so it no longer reads like a user-authored message. Todo List Snapshots are projected from the session's state entries on every request, so a resumed session shows its older tool groups with the new header and one Todo List Snapshot each; that changes the prompt-cache prefix once for sessions started before the upgrade.

## 0.2.0

### Minor Changes

- 0ea1e75: These packages now require Pi `>=0.99.0`, raised from an undeclared (`*`) peer range and a documented floor of `0.84.1` or `0.85.1`. Pi 0.99.0 is the first release that provides the tool exposure, output schema, and built-in extension APIs the repository uses, so the packages no longer carry fallbacks for older hosts.

  Advisor no longer probes the Pi SDK for missing exports and methods at load. It no longer pauses with "this Pi runtime lacks ..." diagnostics, because the peer range guarantees those members. Minimal Subagents always gives Child Agents Pi's built-in `codemode`, `tool-search`, and `mcp` extensions instead of skipping any the host lacked. Termctrl's `bash` replacement now requires Pi's `bash` to declare an object `outputSchema`, which Pi provides from 0.99.0, instead of silently falling back to an empty schema.

- bf36a67: The `todo` tool now declares MCP-style tool `annotations`: not read-only, non-destructive (it only appends to the session's own journal), not idempotent, and closed-world. Pi reports them through `pi.getAllTools()`, so permission extensions can tell that it never touches the environment beyond the session. Annotations are not sent to model providers, so tool declarations, the system prompt, and the prompt cache prefix are unchanged.
- 98b14ae: The `todo` tool now declares an `outputSchema` and returns matching `structuredContent`, so a Pi `codemode` script gets an object instead of the text. `list` returns `{ action, tasks }`. `add` and `update` return the resulting `task`, so a script can read the new Task's ID. `remove` returns the removed `id`, and `clear` returns the number of Tasks `cleared`. Field names are single words, so they already match the snake_case convention of Pi's `bash` and `pi-termctrl`. The text the model reads, the hidden Todo List context, and error behavior are unchanged. Scripts that parsed the old text result, such as `Added Task #3`, must read the object instead. Pi appends a one-line result summary to the tool's description once.

## 0.1.4

### Patch Changes

- 2daa891: Bundled troubleshooting Skills no longer appear in the model's system prompt. Each now sets `disable-model-invocation: true`, so installing the package adds no per-turn context and you no longer need `skills` package filters to hide them. To open one, use `/skill:<package>` or a `$<package>` Skill Reference. Packages whose failures the model can see append that package's Skill path to configuration and runtime failures, so the model loads the guide only when one occurs.

## 0.1.3

### Patch Changes

- e6620c4: Keep Todo snapshots working after compaction on Pi 0.87. Compaction checkpoints now carry a system snapshot that `context` handlers never receive, so Todo projection anchors on the first conversation message instead of failing with "anchor is missing or ambiguous".

## 0.1.2

### Patch Changes

- d839d25: Preserve conversation cache prefixes by projecting immutable Todo snapshots at stable journal positions, including across tool groups and compaction.

## 0.1.1

### Patch Changes

- 1a2e2b9: Remove lint workarounds from package code

## 0.1.0

### Minor Changes

- 304857e: Add session-native Todo List tracking with branch-aware persistence, hidden model context, a compact widget, custom transcript rendering, and the `/todo clear` command.
