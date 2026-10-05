---
"@ian-pascoe/pi-lsp": minor
---

`lsp_code_actions` no longer loses a server's other actions when one action's edit fails Workspace Edit Preview validation, such as an edit that targets a missing file. That action is listed with `applicable: false` and an `error` explaining why, the server's other actions and their previews are returned as usual, and the server is no longer reported as a failed request. The structured result adds the optional `error` field on actions.
