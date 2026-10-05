---
"@ian-pascoe/pi-lsp": minor
---

A server can now cover a whole monorepo with the new `workspaceRootMarkers` setting, such as `["pnpm-workspace.yaml"]` or `[".git"]`. The nearest ancestor that contains one of these markers becomes the server root, so files in every package share one server, and `lsp_find_references` and `lsp_rename` find and edit usages in other packages. Servers without the setting route exactly as before.

The search never selects your home directory or anything above it unless Pi's working directory is there. Without a match, the nearest `rootMarkers` ancestor and then the working directory are used as before. `requireRootMarker` still checks only `rootMarkers`.

Packages inside a workspace root are no longer reported as other workspace roots, so the "searched only its workspace root" warning no longer appears for them.

A language server searches only the packages it has loaded, and Pi LSP never opens files to load them. In a workspace root, `lsp_find_references` and `lsp_rename` therefore warn about packages where the server has no open file yet, such as `typescript has not loaded files from packages/b under /work/repo; their references may be missing`, and suggest running any LSP tool on a file there before retrying.
