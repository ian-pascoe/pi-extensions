---
name: pi-secret
description: Diagnose Pi Secret when secret_ask, Secret Grants from 1Password, Secret References, redaction, the Secret Lifetime setting, or restored Secrets are missing or incorrect.
license: MIT
disable-model-invocation: true
---

# Pi Secret

1. Read [`../../README.md`](../../README.md) for the expected prompt, reference, redaction, lifetime, and persistence behavior. Never ask the user to reveal a value while diagnosing.
2. Call `secret_list`. A missing tool is an extension-loading failure. An empty list after `secret_ask` reported `provided` means the Secret expired, was forgotten, or belongs to another session branch.
3. If `secret_ask` fails, check the mode: it needs Pi's interactive terminal and fails in print, JSON, and RPC modes and in Child Agents.
4. If a call was blocked, compare its references with `secret_list`: every `{{secret:NAME}}` and `PI_SECRET_NAME` it contains must name a held Secret. Mentioning `PI_SECRET_NAME` in text that is not a reference also blocks the call unless a backslash comes right before it.
5. If `secret_ask_grant`, `secret_save`, or a call using a granted Secret fails to read 1Password, check in a terminal the user controls that `op whoami` succeeds and `op read` of the same locator works; 1Password may be locked or `op` signed out. If the tools are missing, `op` was not on `PATH` when Pi loaded. If an item is refused, check `secret.providers.1password.vaults` and `account`.
6. Check `secret.lifetimeMinutes` in Pi's global settings, and in the project's settings when the project is trusted: an integer from 1 to 1440. An invalid value falls back to 15 minutes with a warning at session start.
7. If Secrets do not survive a resume, check that `~/.pi/agent/pi-secret/keys.json` exists, is readable by the user, and is valid JSON. The session's `pi-secret` entries hold only ciphertext; without the key file they cannot be restored, and the user must enter them again.
8. If a value appears in output, confirm the result came through Pi (redaction applies to stored results and provider requests, not to live streaming output) and that the value was entered through `secret_ask` in this Pi process.
9. Finish when `secret_list`, a test call using a reference, and its redacted result agree, or one named mode, setting, key-file, or branch boundary explains the mismatch.
