---
status: accepted
---

# Own language presets and share private tool installation

Pi LSP, Pi DAP, and Pi Formatter will own their Language Tool Presets while sharing
one internal installer backed by a privately provisioned mise: editor registries
supply useful references and package metadata, but not these extensions' routing,
formatting, or launch semantics. Automatic first-use installation will include
required runtimes in a private per-user store, without changing project files,
system installations, or the user's PATH; this deliberately accepts installation
and supply-chain responsibility to provide out-of-the-box support on native x64
and ARM64 Linux, macOS, and Windows. Managed Installations resolve latest on first
installation and explicit Tool Updates, trading release-pinned versions for
upstream freshness while preserving working installations and running processes.

This supersedes the catalog/installation exclusions in
[Pi LSP ADR-0001](../../packages/pi-lsp/docs/adr/0001-own-a-narrow-lsp-client.md)
and the adapter discovery/catalog exclusion in
[Pi DAP ADR-0001](../../packages/pi-dap/docs/adr/0001-own-a-narrow-dap-client.md),
and reopens Pi Formatter's settings-only/catalog-free boundary. Their narrow
protocol clients and other exclusions remain intact: the shared installer does
not acquire ownership of protocol lifecycle, formatter selection, project builds,
or arbitrary launch inference.

The [accepted design](../plans/managed-language-tools.md) records scope, precedence,
updates, failure behavior, and verification gates. This is an accepted direction,
not an implemented feature; existing package documentation still describes the
current settings-only runtime until implementation lands.
