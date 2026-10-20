# Save typed Secrets into Env Files, warning but not blocking when git does not ignore them

The Env File Secret Provider reads Secret Grants from `.env*` files in the project and from files listed in global settings, and it also saves typed Secrets into them, even though Pi Guardian treats `.env*` files as sensitive and a project Env File may be committed. Users keep project credentials in Env Files already, so a read-only provider would leave a typed Secret with no durable home except 1Password. Saving only ever adds a key: it refuses a key the file already defines, and creates a missing file with owner-only permissions. When git does not ignore a project Env File, the approval dialog says so, but the save or grant still goes ahead if the user approves. Only global settings may list Env Files outside the project, because a trusted project's own settings could otherwise point the agent at credentials anywhere in the user's home directory.

## Considered Options

- **Read-only Env Files**: rejected because users who keep credentials in Env Files would have to copy a typed value there by hand, and the agent can already write a value into any file through a Secret Reference.
- **Refuse files git does not ignore**: rejected because the user chose to accept that risk; the dialog warning makes it visible when they approve.
- **Let project settings list any Env File**: rejected for the reason above; this matches how the 1Password vault allowlist fails closed.

## Consequences

- A saved value lands in a plaintext file the user owns. Its Secret Lifetime still ends the grant, but it does not delete the key from the file.
