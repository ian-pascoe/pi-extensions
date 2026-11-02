---
"@ian-pascoe/pi-utils": minor
---

Add `@ian-pascoe/pi-utils/prose-references`, the shared Reference Sigil machinery behind selector packages. `replaceProseReferences(text, { sigil, name, resolve })` replaces shorthand such as `$skill` inside Prose Spans (Markdown outside code, links, HTML, and escapes) with what `resolve` returns for each name, leaving unresolved names literal. `findProseReferencePrefix(text, cursorOffset, { sigil, partialName })` finds the shorthand prefix at the cursor. `stackProseReferenceAutocomplete(current, { sigil, partialName, suggest })` stacks a completion popup for one sigil over an existing autocomplete provider and delegates everything else to it. Needs `@earendil-works/pi-tui`, an optional peer.
