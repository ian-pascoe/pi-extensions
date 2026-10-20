# Read Secret Grants from the Secret Provider at each use, not sealed into the session

A typed Secret has no other home, so Pi Secret encrypts it into the session and keeps its key outside the session until the Secret Lifetime ends. A Secret Grant already points at a value that lives in a Secret Provider. The session therefore stores only the grant (Secret Name, Secret Locator, and expiry), and Pi Secret reads the value again from the Secret Provider on every tool call that uses the Secret. This keeps one-time passwords current, picks up rotated values, lets the user cut access by revoking it in the Secret Provider, and keeps another copy of the credential out of the session. If a read fails, the call is blocked, and the last value read is never used in its place.

## Considered Options

- **Read once at approval and seal the value like a typed Secret**: rejected because one-time passwords go stale within seconds, a value rotated or revoked in the Secret Provider would keep working until expiry, and the session would hold a copy of a credential that already has a home.

## Consequences

- Each use costs one Secret Provider read (about 0.3–1 s for the `op` CLI) and fails while the Secret Provider is locked or signed out.
- Child Agents need fresh reads too, so the shared redaction registry gains a refresh callback ([ADR-0010](../../../../docs/adr/0010-secret-registry-refresh-callbacks.md)).
- Saving a typed Secret into a Secret Provider turns it into a Secret Grant: its sealed copy and key are destroyed, and it keeps its original expiry.
