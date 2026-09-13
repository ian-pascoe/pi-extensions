---
status: accepted
---

# Isolate framework TypeScript compatibility

Framework language servers can require JavaScript TypeScript SDK APIs unavailable
from native TypeScript 7, so their Managed Installations may include a
latest-compatible SDK and the necessary framework integration while TypeScript 7
remains the default outside that compatibility path. This qualifies
[ADR-0004's](0004-own-language-presets-and-share-managed-installation.md) latest-version
rule for those supporting SDK dependencies, not the language-server release itself,
and leaves project dependencies unchanged. We accept maintaining that compatibility
path rather than excluding framework support or replacing TypeScript 7 globally;
the [expansion design](../plans/language-tool-preset-expansion.md) records the scope
and verification requirements.

The same latest-compatible dependency policy applies to the curated Svelte/Astro
Prettier plugins, preferring compatible project installations without upgrading
project dependencies or replacing the selected external formatter. It does not
authorize acquisition of arbitrary project-configured plugins.
