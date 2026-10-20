# @ian-pascoe/pi-secret

## 0.3.0

### Minor Changes

- 2dda271: Add the Env File Secret Provider: grant Secrets from `.env` and `.env.*` files in the project, or files listed in global `secret.providers.dotenv.files`, through `dotenv://<path>#<KEY>` Secret Locators, read again at each use, and save typed Secrets into them as new keys. It is on when Pi starts in a directory with a top-level Env File, or when global settings list files or set `enabled: true`; global `enabled: false` turns it off. The approval dialogs warn when git does not ignore a project Env File. Project settings for one Secret Provider no longer replace global settings for the others.

## 0.2.0

### Minor Changes

- 911033b: Add Secret Providers, starting with 1Password through the `op` CLI. `secret_list` now searches Secret Providers for items and fields (`query`, `provider`, `vault`, `item`, `status`, `limit`), never values. `secret_ask_grant` asks the user to approve Secret Grants, each a Secret Name and the 1Password Reference (`op://vault/item/field`) its value is read from again at each use, so one-time passwords stay current. `secret_save` saves a typed Secret into a new 1Password item after the user approves. The session stores only a grant's locator, never its value. Optional `secret.providers.1password.account` and `vaults` settings narrow what the agent can see. A backslash right before a Secret Reference now makes it literal text, so documentation and tests can contain the syntax. Provider-request scrubbing now leaves a message already sent unchanged when a value held later appears in it, so holding a Secret no longer discards the provider's prompt cache.

### Patch Changes

- Updated dependencies [911033b]
  - @ian-pascoe/pi-utils@0.10.0

## 0.1.1

### Patch Changes

- Updated dependencies [16eaaf1]
  - @ian-pascoe/pi-utils@0.9.0

## 0.1.0

### Minor Changes

- 2bda153: Add Pi Secret: `secret_ask` asks the user for Secrets, such as API keys and passwords, in a masked prompt, and the agent uses them through `$PI_SECRET_NAME` and `{{secret:NAME}}` Secret References. Values never reach the model provider, the session file, or the screen. Tool results and provider requests are redacted, including values printed in common encodings such as base64 in an HTTP Basic `Authorization` header. Secrets expire after a configurable Secret Lifetime, and their per-Secret encryption keys are deleted, so the session's encrypted copies can no longer be read.

### Patch Changes

- Updated dependencies [2bda153]
  - @ian-pascoe/pi-utils@0.8.0
