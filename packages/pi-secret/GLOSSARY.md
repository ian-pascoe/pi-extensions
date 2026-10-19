# Secret context

The Secret context lets an agent use credentials the user enters without the values reaching the model provider, the session file, or the screen.

## Language

**Secret**:
A credential value the user entered in answer to a Secret Request, usable by the agent only through its Secret References until it expires or is forgotten.
_Avoid_: Credential, password, env var

**Secret Name**:
The identifier a Secret is requested and referenced by, written in environment-variable style (such as `OPENCODE_API_KEY`).
_Avoid_: Key, secret key, label

**Secret Reference**:
A string standing in for a Secret's value wherever the agent writes or reads it: `{{secret:NAME}}` in any tool argument, or the `PI_SECRET_NAME` environment variable in a spawned process. The agent and the transcript only ever see references.
_Avoid_: Placeholder, token, handle

**Secret Request**:
An agent's request for one or more Secret Names, optionally with a reason shown to the user, which the user answers by entering, skipping, or cancelling each value. Every request prompts again and replaces any Secret already held under the same name.
_Avoid_: Prompt, secret ask

**Secret Lifetime**:
The fixed span the user configures, counted from entry, after which a Secret expires and can no longer be read anywhere, including from the sessions that recorded it. The agent can neither choose nor extend it.
_Avoid_: TTL, session lifetime, timeout

**Redaction**:
Replacing every occurrence of a held Secret's value with its Secret Reference in what a tool returns or the provider receives.
_Avoid_: Masking, scrubbing
