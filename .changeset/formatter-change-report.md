---
"@ian-pascoe/pi-formatter": minor
---

A File Formatter that changes a file now says so. After a successful `edit`, `write`, or applied Workspace Edit Preview (`lsp_apply`), the result gains a line such as `Formatted by oxfmt: lines 4–7 changed`, so the agent knows its copy of the file is stale; before, formatting was silent and the next `edit` reusing the just-written text failed with "Could not find the exact text". The line numbers describe the formatted file, as one span from the first to the last changed line, and nothing is added when the content is unchanged. A formatter failure whose stderr reports a syntax error, which Post-edit Diagnostics already reports, no longer ends with the troubleshooting Skill pointer; spawn errors, timeouts, and other failures keep it.
