# Secret context

The Secret context lets an agent use credentials the user enters, or grants from a Secret Provider, without the values reaching the model provider, the session file, or the screen.

## Language

**Secret**:
A credential value, entered by the user or read through a Secret Grant, usable by the agent only through its Secret References until it expires or is forgotten.
_Avoid_: Credential, password, env var

**Secret Name**:
The identifier a Secret is requested and referenced by, written in environment-variable style (such as `OPENCODE_API_KEY`).
_Avoid_: Key, secret key, label

**Secret Reference**:
A string standing in for a Secret's value wherever the agent writes or reads it: `{{secret:NAME}}` in any tool argument, or the `PI_SECRET_NAME` environment variable in a spawned process. The agent and the transcript only ever see references.
_Avoid_: Placeholder, token, handle

**Secret Provider**:
An external store of credentials, such as 1Password, that Secrets can come from instead of being typed by the user, or that the user's typed Secrets can be saved into.
_Avoid_: Backend, vault, secret manager, source

**Secret Grant**:
The user's approval, given in answer to a Grant Request or when saving a typed Secret, for one Secret Name to be read from one location in a Secret Provider until the Secret Lifetime ends. The value is read again from the Secret Provider each time it is used.
_Avoid_: Permission, authorization, access

**Secret Locator**:
The location of one value in a Secret Provider, written as a URI whose scheme names the Secret Provider. A Secret Grant points at one Secret Locator.
_Avoid_: Path, address, provider reference

**1Password Reference**:
The Secret Locator form for 1Password: `op://vault/item/field`.
_Avoid_: Secret Reference (that term means the agent's stand-in for a Secret), op URI

**Secret Request**:
An agent's request for one or more Secret Names, optionally with a reason shown to the user, which the user answers by entering, skipping, or cancelling each value. Every request prompts again and replaces any Secret already held under the same name.
_Avoid_: Prompt, secret ask

**Grant Request**:
An agent's request for one or more Secret Grants, each naming a Secret Name and a Secret Locator, optionally with a reason shown to the user, which the user answers by approving or denying each grant or cancelling them all. Like a Secret Request, it replaces any Secret already held under the same name.
_Avoid_: Grant prompt, access request

**Secret Lifetime**:
The fixed span the user configures, counted from entry or approval, after which a Secret or Secret Grant expires and can no longer be read anywhere, including from the sessions that recorded it. The agent can neither choose nor extend it.
_Avoid_: TTL, session lifetime, timeout

**Redaction**:
Replacing every occurrence of a held Secret's value, as is or in a common encoding such as base64, with its Secret Reference in what a tool returns or the provider receives.
_Avoid_: Masking, scrubbing
