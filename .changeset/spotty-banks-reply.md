---
"@ian-pascoe/pi-tool-installer": minor
"@ian-pascoe/pi-utils": minor
"@ian-pascoe/pi-lsp": minor
"@ian-pascoe/pi-formatter": minor
"@ian-pascoe/pi-dap": minor
---

Expand the package-owned language tool presets across web frameworks, configuration
files, lint companions, formatters, and Deno/compiled-program debugging. Preserve
explicit configuration and external installation precedence, use compatible private
SDK/plugin/runtime dependencies, and document each preset's verified native support.

Support exact runtime acquisition, isolated .NET installations, and published
checksums for native HTTP artifact acquisition in the shared installer. Add shared
read-only Deno executable resolution so language tools can use existing npm native
payloads without invoking wrappers that repair project dependencies.

Svelte LSP uses the approved publishing-trust exception only for the historical
`svelte@4.2.20` dependency, retaining integrity verification and lifecycle-script
denial.

Bundle ahead-of-time Windows x64/ARM64 preflight helpers that atomically contain
Python/.NET runtime probes and their descendants in an owned Job, without adding
end-user compiler or SDK prerequisites or changing Debug Session ownership.
