# Pi Secret

`@ian-pascoe/pi-secret` lets a Pi agent use **Secrets**, such as API keys, passwords, and tokens, that the user types into a masked prompt. The values never reach the model provider, are never written to the session file in plaintext, and are never shown on screen. The agent works only with **Secret References**.

It can also read Secrets from a **Secret Provider**, 1Password or the project's **Env Files**, through **Secret Grants** the user approves, and save a typed Secret into one.

Requires Node `>=22.19.0` and Pi `>=1.1.0`. The 1Password Secret Provider needs the [1Password CLI](https://developer.1password.com/docs/cli/) (`op`), signed in; Env Files need nothing else.

> **Pi Secret keeps values out of the conversation; it is not a sandbox.** A Secret is usable by any command the agent runs while it is held, and a misbehaving agent can still send it somewhere, for example with `curl`. Pi Secret redacts values it recognizes in tool output, but pair it with [Pi Guardian](../pi-guardian) to review what the agent does with a Secret.

## Install

```bash
pi install npm:@ian-pascoe/pi-secret
# or from this checkout
pi -e ./src/index.ts
```

## How it works

1. The agent calls `secret_ask({ names: ["OPENCODE_API_KEY", "OPENCODE_PASSWORD"], reason?: "…" })`.
2. Pi shows a masked dialog with the reason and the Secret Lifetime. Each name has its own field, and each character typed shows as one bullet. Paste works, and Tab and Shift+Tab move between fields. Enter submits, an empty field skips that name, and Escape cancels the whole request. A value shorter than 8 characters gets a warning, because redacting it can also hide unrelated output.
3. The tool result tells the agent, for each name, whether it was `provided`, `skipped`, or `cancelled`, how to reference it, and when it expires. It never contains the value.
4. The agent uses the Secret through a reference:
   - **`$PI_SECRET_NAME`** in shell commands. While a Secret is held, Pi Secret exports it as an environment variable of the Pi process, so `bash`, Terminal Control's terminals, and other spawned processes inherit it. The value stays off the command line.
   - **`{{secret:NAME}}`** in any string argument of any tool, such as a `write` to a `.env` file or a header of an HTTP tool. Pi Secret replaces it just before the tool runs. The transcript, the session file, and the provider keep the reference.
5. Every tool result is redacted before Pi stores it or sends it to the provider. Each occurrence of a held value, or of any value held earlier in this process, is replaced with its `{{secret:NAME}}` reference, whether it is printed as is or in a common encoding: JSON string escaping, percent-encoding, hex, or base64 and base64url at any alignment, as in an HTTP Basic `Authorization` header. Encoded forms are matched only for values of 8 characters or more, since shorter ones can occur by chance. This covers `content`, `details`, and `structuredContent`, nested `codemode` calls and the outer `codemode` result, and the full output file a truncated `bash` result points at (`fullOutputPath` or `full_output_path`), which is redacted in place. If a result cannot be checked, it is withheld and replaced with an error. Each provider request is also scrubbed, so a value the user pastes into the chat by mistake is replaced as well. A message already sent is scrubbed the same way on every later request, so a value held afterwards never rewrites it and the provider's cached prompt prefix stays valid.

A call that references a Secret this session does not hold, in either form, is blocked before it runs. For a name that expired, was forgotten, or was never provided, the agent is told to call `secret_ask` again; for a malformed name, such as `{{secret:lower}}` or an empty `{{secret:}}`, it is told what a Secret Name looks like. A Secret Name must be environment-variable style: `^[A-Z_][A-Z0-9_]*$`.

To write either form as literal text, such as in documentation or tests, put a backslash right before it: `\{{secret:NAME}}` or `\PI_SECRET_NAME`. An escaped reference names no Secret, and Pi Secret removes the backslash just before the tool runs, so the tool receives `{{secret:NAME}}`. The transcript keeps the call as written. In a shell command, the shell's own escape, `\$PI_SECRET_NAME` or `\${PI_SECRET_NAME}`, is literal to the shell as well, so Pi Secret leaves it exactly as written. Prefer it there: `$\PI_SECRET_NAME` loses its backslash and becomes an expansion the shell runs without Pi Secret checking or refreshing it.

### Secret Providers and Secret Grants

Pi Secret has two Secret Providers, each decided once at load:

- **1Password** (`1password`), when the 1Password CLI (`op`) is on `PATH`.
- **Env files** (`dotenv`), when Pi starts in a directory with a `.env` or `.env.*` file at its top level, or when global settings list Env Files or set `enabled: true` (see [Env Files](#env-files)). Global `enabled: false` turns it off.

With at least one, Pi Secret adds `secret_ask_grant` and `secret_save`, and one line of guidance to the system prompt naming the providers loaded. Both are decided once, so the tool set and prompt never change within a session.

1. The agent finds an item with `secret_list` (for example `query: "github"`), then lists its fields with `item`. Each field comes with its **Secret Locator**: the 1Password Reference `op://vault/item/field`, or an Env File locator such as `dotenv://.env.local#API_KEY`. Values are never listed.
2. The agent calls `secret_ask_grant({ grants: [{ name: "GITHUB_TOKEN", locator: "op://Dev/GitHub/token" }], reason?: "…" })`. Pi shows each grant's Secret Name, vault, item, field, and field type. Every grant starts allowed: Space toggles one between allow and deny, Enter submits, and Escape cancels them all.
3. Pi Secret reads each allowed grant once, so a wrong locator, a missing key, or a locked 1Password shows up in the result, as `granted`, `denied`, `cancelled`, or `failed` with the reason. A value shorter than 8 characters is granted with a warning.
4. The agent uses the Secret through its Secret References, as with a typed Secret. Pi Secret reads the value again from its Secret Provider on every tool call that references it, so one-time passwords (`?attribute=otp`) are always current and a value rotated, revoked, or edited takes effect at once. If the read fails, the call is blocked, and the last value read is never used in its place.

`secret_save({ name, locator, category? })` saves a Secret the user typed into this session somewhere new, after the user approves it in a dialog, and never changes anything that exists:

- Into a **new** 1Password item, such as `op://Dev/OpenAI API/credential`. The category defaults to API Credential. It refuses a title the vault already has. The value reaches `op` on stdin, never on its command line. The grant's locator uses the new item's ID, so it survives renames.
- As a **new key** in an Env File, such as `dotenv://.env.local#OPENAI_API_KEY`. It refuses a key the file already defines, and `category`. Pi Secret appends one `KEY=value` line itself, quoted so the file reads back exactly the value, and refuses a value no quoting can round-trip. A missing `.env` or `.env.*` file is created with mode `0600`, inside the project or at a listed path only.

The Secret then becomes a grant on the saved locator, and it keeps its original expiry.

### Env Files

An **Env File** is a file of `NAME=value` lines named `.env` or `.env.*` (not `.envrc`) anywhere in the project, the session's working directory. `secret_list` searches the whole project for them, gitignored ones included, but skips `.git` and `node_modules`. Each Env File is an item, shown in a vault named after the project directory, and its keys are its fields.

- **Locators** are `dotenv://<path>#<KEY>`. A path in the project is relative to it, such as `dotenv://packages/api/.env#DATABASE_URL`; a path outside is absolute, such as `dotenv:///Users/me/.config/tool/.env#TOKEN`, and `~/` is accepted. A relative locator in a resumed grant resolves against the session's project directory.
- **Values** are parsed as Node's `util.parseEnv` does: the last definition of a key wins, and `${VAR}` is kept literally, never expanded.
- **Links**: an Env File that links outside the project is used only when its target is listed in settings.
- **Git**: when git does not ignore a project Env File, the grant and save dialogs say "not ignored by git". This is a warning only; approving still grants or saves ([ADR-0003](docs/adr/0003-save-typed-secrets-into-env-files.md)).

To use other files, such as one in your home directory, list their exact paths, absolute or `~/…`, in global settings:

```json
{
  "secret": {
    "providers": { "dotenv": { "files": ["~/.config/tool/.env"] } }
  }
}
```

Only global settings may list files outside the project; a trusted project's settings may list files inside it, and any entry outside it is ignored with a warning. `enabled: true` turns the provider on without a top-level Env File, and `enabled: false` turns it off; both work in global settings only, because Pi decides the tool set before it knows the project.

A Secret Name holds one Secret at a time: a newer `secret_ask`, `secret_ask_grant`, or `secret_save` replaces whatever was held under that name.

### Tools

| Tool               | Input                                                         | Result                                                                                                                     |
| ------------------ | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `secret_ask`       | `names`, `reason?`                                            | Each name's outcome, references, and expiry                                                                                |
| `secret_ask_grant` | `grants` (`name`, `locator`), `reason?`                       | Each grant's outcome, references, and expiry                                                                               |
| `secret_list`      | `query?`, `provider?`, `vault?`, `item?`, `status?`, `limit?` | Held Secrets with their expiry and each grant's Secret Locator, and matching Secret Provider items or fields; never values |
| `secret_save`      | `name`, `locator`, `category?`                                | The new item's or key's Secret Locator                                                                                     |
| `secret_forget`    | `names`                                                       | Forgets the named Secrets, typed or granted, now, before their lifetime ends                                               |

`secret_list` returns held Secrets and up to `limit` (default 20) available items from each Secret Provider. With `item`, it lists that item's fields instead. `status: "held"` skips the Secret Provider search, and a Secret Provider that cannot be searched is reported in the result, not as an error.

Every `secret_ask` prompts again and replaces any Secret already held under the same name, so the user can correct a mistyped value. Pi Guardian allows all five tools by default, since none reveals a value, and grants and saves need the user's approval in Pi Secret's own dialog. Calls that use a Secret Reference are judged by their own tool's policy, and Guardian reviews them with the reference, never the value.

### `/secret` command

`/secret` (or `/secret list`) lists held Secrets and when they expire. `/secret forget NAME…` forgets the named Secrets and `/secret forget all` forgets every one.

## Lifetime and persistence

The **Secret Lifetime** is fixed at entry and counted from when the user enters the value. Set it in Pi's global or trusted-project settings; the agent cannot choose or extend it:

```json
{
  "secret": { "lifetimeMinutes": 15 }
}
```

`lifetimeMinutes` must be an integer from 1 to 1440 (default 15). A Secret Grant lasts the same lifetime, counted from approval.

The 1Password Secret Provider uses `op`'s default account and every vault `op` can see. To narrow it, name the account and the vaults (names or IDs) the agent may search, request grants from, and save into:

```json
{
  "secret": {
    "providers": { "1password": { "account": "my.1password.com", "vaults": ["Dev"] } }
  }
}
```

Each Secret Provider's project settings replace that provider's global settings only; listed Env Files from both add up. Invalid settings fall back to a 15-minute lifetime, no 1Password vaults, and only the project's own Env Files, with a warning, so a mistyped list never widens access.

Each Secret is encrypted with its own random AES-256-GCM key. The ciphertext is stored as a `pi-secret` custom entry in the session; the key is stored in `~/.pi/agent/pi-secret/keys.json` (mode `0600`), outside the session. The ciphertext is bound to its name, key, and expiry. As a result:

- Resuming, forking, or reloading a session within the lifetime restores its Secrets. Navigating the session tree holds only the Secrets entered on the selected branch.
- When the lifetime ends, or the Secret is forgotten, its key is deleted, so the session's copy can never be decrypted again. Keys are deleted by a timer, before any tool call once expired, and when a session starts. After that the session file is safe to share as far as Pi Secret is concerned.
- This does not protect against someone who can read your disk while a Secret is held: the key file and the session file sit on the same machine.

A Secret Grant is stored differently ([ADR-0001](docs/adr/0001-read-secret-grants-at-each-use.md)): its `pi-secret-grant` entry holds only the Secret Name, Secret Locator, and expiry, never a value, since the value is read from the Secret Provider at each use. A resumed grant is not read until its first use, so resuming never prompts 1Password. Saving into an Env File writes the value to that file in plaintext; when the Secret Lifetime ends, the grant ends, but the key stays in the file. Forgetting any Secret records a `pi-secret-forget` entry, so it is not restored. Saving a typed Secret deletes its key, as forgetting does.

Child Agents, such as Minimal Subagents children in the same Pi process, can use Secrets their root session holds, through the process-wide registry in `@ian-pascoe/pi-utils` ([ADR-0008](../../docs/adr/0008-secret-redaction-registry-in-pi-utils.md)). They cannot ask for new ones or forget the root's. A Child Agent using a granted Secret reads it fresh from the Secret Provider, as the root does ([ADR-0010](../../docs/adr/0010-secret-registry-refresh-callbacks.md)).

## Limitations

- **Interactive terminal only**: `secret_ask`, `secret_ask_grant`, and `secret_save` fail in print, JSON, and RPC modes and in Child Agents, because only Pi's terminal UI can show their dialogs.
- **1Password approves the CLI, not each item**: once `op` is unlocked, it can read any item in the vaults it can see. Pi Secret reads only locators the user granted, but `secret_list` sends item titles and field labels from those vaults to the model provider. Use `secret.providers.1password.vaults` to narrow what it can see; it is checked at every read, so narrowing it also stops grants already held. The grant dialog names the account only when `account` is set.
- **One-time passwords stay redacted**: every value read is redacted for the rest of the process, including each 6-digit code, so a later output containing the same digits by chance shows the Secret Reference instead.
- **Reads cost time**: each tool call using a granted 1Password Secret runs `op read` first, typically well under a second, and fails while 1Password is locked or `op` is signed out.
- **Env Files are plaintext**: Pi Secret reads them only through grants the user approves, but the agent's own tools can read an Env File unless Pi Guardian or another policy stops them. `secret_list` sends Env File paths and key names, never values, to the model provider.
- **Large projects**: `secret_list` walks the whole project for Env Files, outside `.git` and `node_modules`, on each search; a very large tree makes it slow.
- **A restored grant's variable**: `PI_SECRET_NAME` for a grant restored on resume is exported at its first use, so a program that reads it from the environment without the call naming it sees nothing until then.
- **Running processes keep their environment**: `PI_SECRET_NAME` is unset when a Secret expires or is forgotten, but a terminal or server started while it was held keeps its copy until it exits.
- **Streaming output**: Pi shows a running tool's partial output live, before the final result is redacted, so a command that prints a Secret can show it on screen until its result arrives. The stored result and the provider never see it.
- **Other extensions' hooks**: the arguments object Pi passes to later `tool_call` and `tool_result` handlers holds the resolved value, and a `tool_result` handler that runs before Pi Secret's sees unredacted output. Pi Guardian redacts its own copy (ADR-0008).
- **Values the agent or user write themselves**: Pi Secret scrubs provider requests, but a value typed into the chat is still saved in the session file as typed. Likewise, a user shell command such as `!env` prints the `PI_SECRET_*` variables to the screen and records them in the session.
- **Calls another extension blocks**: Pi skips `tool_result` for a blocked call, so if an extension loaded after Pi Secret blocks a call and quotes its resolved arguments in the reason, that text is not redacted.
- **Values seen before they were held**: a message the provider received before a value was held keeps that value in later requests, because the provider already has it and rewriting the message would discard its prompt cache. This happens when a Secret Grant reads a value that already appeared, such as a username in a 1Password item title that `secret_list` returned. Everything sent after the value is held is redacted.
- **One value under two names**: redaction names the Secret entered last with that value.
- **Other transformations**: a value the agent reverses, hashes, splits, compresses, or prints only in part is not recognized, so it is not redacted. Redaction is a safety net for accidental output, not a defence against a command built to reveal a Secret.
- **Mentioning the prefix**: any unescaped `PI_SECRET_NAME` word in a call's arguments counts as a reference, so text that only mentions an unheld one, such as `env | grep PI_SECRET_X`, is blocked; write `\PI_SECRET_X` instead. The bare prefix names no Secret, so `env | grep PI_SECRET_` runs, and its output is redacted.
- **`{{secret:NAME}}` in shell commands** puts the value on the command line, where `ps` can see it; prefer `$PI_SECRET_NAME`.
