---
status: accepted
---

# Separate installer and preset platform support

The six-platform requirement in
[ADR-0004](0004-own-language-presets-and-share-managed-installation.md) applies to
the shared installer: each Language Tool Preset may instead support a documented,
verified subset of native Linux/macOS/Windows x64+ARM64. This accepts unequal tool
coverage rather than excluding useful presets solely because upstream platform
support differs; all-at-once delivery means the complete agreed catalog with its
declared support matrix, not every tool on every platform. Claimed supported
platforms still require acquisition and operation proofs, unsupported availability
must be reported truthfully, and private installation, existing ownership, and
preservation of working installations remain unchanged.
