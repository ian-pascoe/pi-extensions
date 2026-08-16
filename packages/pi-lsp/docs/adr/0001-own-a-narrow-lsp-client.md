# Own a narrow LSP client

`@ian-pascoe/pi-lsp` owns its LSP client instead of depending on an existing Pi LSP extension. The inspected extensions expose no stable library boundary and either target older Pi APIs, provide only read operations, or bundle server catalogs, installers, formatters, static parsing, and debugging that this package does not need. The package uses `vscode-languageserver-protocol` for the protocol and implements only configured server lifecycle, the unified `lsp` tool, Post-edit Diagnostics, and validated mutations.
