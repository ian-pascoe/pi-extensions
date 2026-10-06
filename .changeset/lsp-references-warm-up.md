---
"@ian-pascoe/pi-lsp": minor
---

References and rename now open one file in each unloaded workspace package (up to 20 packages, 10 seconds) before searching, so importers in packages not opened before are found, and only packages still unloaded are warned about.
