---
"@ian-pascoe/pi-secret": minor
---

Add Secret Providers, starting with 1Password through the `op` CLI. `secret_list` now searches Secret Providers for items and fields (`query`, `provider`, `vault`, `item`, `status`, `limit`), never values. `secret_ask_grant` asks the user to approve Secret Grants, each a Secret Name and the 1Password Reference (`op://vault/item/field`) its value is read from again at each use, so one-time passwords stay current. `secret_save` saves a typed Secret into a new 1Password item after the user approves. The session stores only a grant's locator, never its value. Optional `secret.providers.1password.account` and `vaults` settings narrow what the agent can see. A backslash right before a Secret Reference now makes it literal text, so documentation and tests can contain the syntax.
