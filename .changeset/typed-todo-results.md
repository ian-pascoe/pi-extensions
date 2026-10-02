---
"@ian-pascoe/pi-todo": minor
---

The `todo` tool now declares an `outputSchema` and returns matching `structuredContent`, so a Pi `codemode` script gets an object instead of the text. `list` returns `{ action, tasks }`. `add` and `update` return the resulting `task`, so a script can read the new Task's ID. `remove` returns the removed `id`, and `clear` returns the number of Tasks `cleared`. The text the model reads, the hidden Todo List context, and error behavior are unchanged. Scripts that parsed the old text result, such as `Added Task #3`, must read the object instead. Pi appends a one-line result summary to the tool's description once.
