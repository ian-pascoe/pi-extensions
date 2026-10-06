---
"@ian-pascoe/pi-formatter": minor
---

After a formatter changes a file, the mutation result now includes a compact unified diff of the changes (capped at 60 diff lines and 6,000 bytes per result, falling back to the `Formatted by` summary line alone), so the agent's next `edit` can match the formatted text without re-reading the file.
