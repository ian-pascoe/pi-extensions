---
"@ian-pascoe/pi-lsp": patch
---

A file that changed on disk after the language server read it no longer fails that server's whole result. Before, one position past the end of such a file made `lsp_goto_definition` and the other location tools, `lsp_call_hierarchy`, `lsp_type_hierarchy`, `lsp_supertypes`, `lsp_subtypes`, `lsp_incoming_calls`, `lsp_outgoing_calls`, `lsp_workspace_symbols`, `lsp_workspace_diagnostics`, `lsp_diagnostics` (related information), and `lsp_inlay_hints` (label-part locations) fail with `line exceeds document length` or `character exceeds line length`. An end-of-line position in the queried file, such as `2147483647`, no longer fails tools such as `lsp_folding_ranges` and `lsp_hover` either.

A character past the end of its line is now clamped to the line end, as the LSP specification says, without a warning. A line past the end of the file keeps the server's position (adding 1 to the line and character), and a position inside a Unicode character snaps to the start of that character. A warning names those files, because their positions may be wrong, and the server's other positions are unaffected.
