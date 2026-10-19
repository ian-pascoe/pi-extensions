# Share held Secret values through a pi-utils redaction registry, not extension load order

Secrets substitutes `{{secret:NAME}}` Secret References into tool arguments in its `tool_call` handler, and Guardian snapshots those arguments in its own handler for review, audit, and drift detection. Pi runs extensions' handlers in load order, and no package controls that order. If Secrets ran first, Guardian's review model and on-disk audit journal would receive plaintext. If it ran second, every resolved call would look like argument drift. So `@ian-pascoe/pi-utils` owns a process-wide registry of held Secret values. Secrets fills it and empties it as Secrets are entered, expire, or are forgotten. Guardian redacts its snapshot through the registry before reviewing or journaling it, and compares arguments for drift in their redacted form, so either load order is safe. It redacts its review evidence the same way, so a held value the user pasted into the conversation does not reach the review model either. The same registry lets Child Agents in the process resolve their root session's Secrets. Neither package imports the other, and each works alone.

## Considered Options

- **Require Guardian to load first**: rejected because load order is user configuration that a package cannot enforce, and getting it wrong leaks Secrets silently.
- **Resolve references inside each tool's `execute`**: rejected because only tools Secrets overrides could resolve references, and overriding `bash` conflicts with Terminal Control's replacement.
