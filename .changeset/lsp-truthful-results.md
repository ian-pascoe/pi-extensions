---
"@ian-pascoe/pi-lsp": minor
---

Several LSP results are now accurate:

- `lsp_status` lists the languages of each Server Definition, as a map from language ID to the file extensions and filenames it handles, so you can tell which server will handle a file.
- `lsp_workspace_diagnostics` no longer returns an empty `fresh` result for a server that answers only document pulls, such as the TypeScript server. For that server it returns `{ status: "unsupported", message }` with an `unsupported` server outcome (shown as "Unsupported" in the transcript), and the message points to `lsp_diagnostics`. Each file's `uri` is now a plain path instead of a `file:` URI, as in other LSP results.
- `lsp_code_actions` without `server_id` lists the actions of every capable server, instead of failing with "provide server_id". Each action names its `server_id`, and failing servers appear in `warnings`. An explicit `server_id` still limits the request to that server. **Breaking for scripts:** the structured result no longer has a top-level `server_id`; read it from each action.
- A Workspace Edit Preview whose edits change nothing, such as formatting an already-formatted file, reports `No changes` and an empty Mutation Manifest. Before, it reported the file as modified. Text edits that leave a file unchanged are left out of every Mutation Manifest.
