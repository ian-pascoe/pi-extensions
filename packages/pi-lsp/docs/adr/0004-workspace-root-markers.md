# Workspace root markers, and warning about unloaded packages

A Server Definition may set `workspaceRootMarkers`, a list of basename globs such as `pnpm-workspace.yaml` or `.git`, separate from `rootMarkers`. When it is set, a file's Server Instance root is the nearest ancestor holding a workspace root marker. Without one, the nearest `rootMarkers` ancestor and then the working directory are used, exactly as for a definition without the setting. The search never selects the home directory, a directory above it, or the filesystem root, unless the working directory is at or above it; this is the limit other-root discovery already used (#222). An empty list is the same as leaving it unset.

Before this, every package of a monorepo with its own `package.json` or `tsconfig.json` got its own Server Instance, so `lsp_find_references` and `lsp_rename` never crossed package boundaries (#221). The searched-root warning from #195 made the gap visible but could not close it.

The Activation Gate is unchanged: `requireRootMarker` checks only `rootMarkers`, so a workspace marker alone never makes a definition apply. A directory counts as another workspace root only when its files would route to a different Server Instance, so packages inside a searched workspace root no longer trigger the #195 warning.

## Spike findings

One TypeScript 7 (`tsc --lsp`) Server Instance rooted at a pnpm-style workspace, with packages `a` and `b` that each have a `tsconfig.json`, where `b` imports a helper from `a`:

- Once any file of `b` was opened in the instance, references to `a`'s helper included `b`'s usages and rename edited `b`. This held with plain per-package `tsconfig.json` files, project references, `paths` mappings, and a root solution `tsconfig.json`.
- With only `a`'s file opened, `b`'s usages were missing in every one of those setups, even after waiting. The server loads a package's project only when a file in it is opened.
- One root `tsconfig.json` that includes every package found `b`'s usages without opening `b`.
- With one Server Instance per package, `a`'s instance never saw `b`'s usages, whatever was opened.

## Unloaded packages are warned about, not loaded

Because of the second finding, a workspace root would otherwise replace a visible gap with a silent one. In a workspace root, `lsp_find_references` and `lsp_rename` therefore name its packages (directories under it holding one of the definition's `rootMarkers` and routing to it) where the Server Instance has no synchronized document, and suggest running any LSP tool on a file there before retrying. A document belongs to its nearest package, the queried file's package counts as loaded, and a package whose documents were all evicted from the client's 100-document cache counts as not loaded again. A definition without `rootMarkers` has no packages to name.

The packages are found by the same single bounded walk that finds other workspace roots, so the warning adds no second scan. Within the walk's 4,096-directory limit, the workspace root's subtree is walked first, then the rest of the discovery base with that subtree skipped. The workspace root is therefore searched even when it lies below a directory the walk otherwise skips (a `.worktrees/x` checkout, `node_modules`, or a symbolic link) or behind many sibling repositories under the working directory. Unchecked directories inside the workspace root make only the package warning say discovery stopped early; the other-roots warning would wrongly point outside the workspace. Unchecked directories outside it, including its ancestors, make only the other-roots result incomplete.

## Considered Options

- **A policy enum on `rootMarkers` (`nearest` / `outermost`).** Rejected: "outermost package marker" picks a stray `package.json` above the repository as readily as the workspace root, and one list cannot both choose the workspace root and keep the Activation Gate and fallback meaning of `rootMarkers`.
- **Open one file per package before references or rename (warm-up).** Rejected: it makes a read silently open files and load projects across the workspace, costs start-up time and memory proportional to the repository on every first query, and still depends on choosing a file that loads the right project. The warning keeps that choice with the agent.
- **Accept the gap and document it.** Rejected: silent incompleteness is what #195 exists to prevent.

## Consequences

A workspace-root Server Instance uses more memory than one per package, and references in a package only become complete after a file there has been opened in the session. In a workspace root, each references or rename call walks up to 4,096 directories to find packages, instead of stopping after a few other roots. The walk lists directories concurrently, but it can still take a few hundred milliseconds in a large repository.
