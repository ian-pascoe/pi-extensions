# Share Agent Lineage through a pi-utils session record, not package coupling

Context Management needs to know a Child Agent's parent and children, which only Minimal Subagents knows, and both packages must remain installable alone. Minimal Subagents therefore writes a small versioned Agent Lineage entry, whose type and schema live in `@ian-pascoe/pi-utils`, into every child session and fork clone, naming its parent's session ID and its own agent ID. Only children carry it: a parent finds its descendants by reading the head of each session in its own session folder, where Minimal Subagents keeps every child. Context Management reads that entry and treats its absence, including in children created before the record existed, as having no lineage; nothing is backfilled. Neither package imports the other, and neither mentions the other in its prompts or tools.

## Considered Options

- **Pi's `parentSession` header**: rejected because Pi forks set it too, fork clones of children would point into the source tree with no API to correct them, and children would nest under parents in `/resume`.
- **In-process event channel**: rejected because it works only while both packages are loaded and cannot describe persisted sessions.
- **Reading the Minimal Subagents Registry**: rejected because it couples Context Management to another package's internal format.
