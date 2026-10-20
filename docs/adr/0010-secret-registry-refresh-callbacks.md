# Let secret registry entries carry a refresh callback

[ADR-0008](0008-secret-redaction-registry-in-pi-utils.md) made `@ian-pascoe/pi-utils` own a process-wide registry of held Secret values, through which Child Agents resolve their root session's Secrets. Pi Secret now reads a Secret Grant's value from its Secret Provider at each use ([pi-secret ADR-0001](../../packages/pi-secret/docs/adr/0001-read-secret-grants-at-each-use.md)). A registry that only caches values would give Child Agents a stale value, such as an expired one-time password. So the owner of an entry can register an asynchronous refresh callback with it. A Child Agent's `tool_call` awaits the callback before substituting the value, and every value it returns stays registered for Redaction, including values that have since been replaced. The synchronous lookup and redaction APIs stay as they are, so Pi Guardian, which only redacts, is unaffected.

## Considered Options

- **Children use the root's most recently read value**: rejected because a Child Agent would then behave differently from its root for one-time passwords and revoked credentials.
