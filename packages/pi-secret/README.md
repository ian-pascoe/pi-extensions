# Pi Secret

`@ian-pascoe/pi-secret` lets a Pi agent use **Secrets**, such as API keys, passwords, and tokens, that the user types into a masked prompt. The values never reach the model provider, are never written to the session file in plaintext, and are never shown on screen. The agent works only with **Secret References**.

Requires Node `>=22.19.0` and Pi `>=1.1.0`.

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
5. Every tool result is redacted before Pi stores it or sends it to the provider. Each occurrence of a held value, or of any value held earlier in this process, is replaced with its `{{secret:NAME}}` reference, whether it is printed as is or in a common encoding: JSON string escaping, percent-encoding, hex, or base64 and base64url at any alignment, as in an HTTP Basic `Authorization` header. Encoded forms are matched only for values of 8 characters or more, since shorter ones can occur by chance. This covers `content`, `details`, and `structuredContent`, nested `codemode` calls and the outer `codemode` result, and the full output file a truncated `bash` result points at (`fullOutputPath` or `full_output_path`), which is redacted in place. If a result cannot be checked, it is withheld and replaced with an error. Each provider request is also scrubbed, so a value the user pastes into the chat by mistake is replaced as well.

A call that references a Secret this session does not hold, in either form, is blocked before it runs. For a name that expired, was forgotten, or was never provided, the agent is told to call `secret_ask` again; for a malformed name, such as `{{secret:lower}}` or an empty `{{secret:}}`, it is told what a Secret Name looks like. A Secret Name must be environment-variable style: `^[A-Z_][A-Z0-9_]*$`.

### Tools

| Tool            | Input              | Result                                                    |
| --------------- | ------------------ | --------------------------------------------------------- |
| `secret_ask`    | `names`, `reason?` | Each name's outcome, references, and expiry               |
| `secret_list`   | —                  | Held Secret Names and their expiry; never values          |
| `secret_forget` | `names`            | Forgets the named Secrets now, before their lifetime ends |

Every `secret_ask` prompts again and replaces any Secret already held under the same name, so the user can correct a mistyped value. Pi Guardian allows all three tools by default, since none reveals a value. Calls that use a Secret Reference are judged by their own tool's policy, and Guardian reviews them with the reference, never the value.

### `/secret` command

`/secret` (or `/secret list`) lists held Secrets and when they expire. `/secret forget NAME…` forgets the named Secrets and `/secret forget all` forgets every one.

## Lifetime and persistence

The **Secret Lifetime** is fixed at entry and counted from when the user enters the value. Set it in Pi's global or trusted-project settings; the agent cannot choose or extend it:

```json
{
  "secret": { "lifetimeMinutes": 15 }
}
```

`lifetimeMinutes` must be an integer from 1 to 1440 (default 15). An invalid value falls back to 15 minutes, with a warning.

Each Secret is encrypted with its own random AES-256-GCM key. The ciphertext is stored as a `pi-secret` custom entry in the session; the key is stored in `~/.pi/agent/pi-secret/keys.json` (mode `0600`), outside the session. The ciphertext is bound to its name, key, and expiry. As a result:

- Resuming, forking, or reloading a session within the lifetime restores its Secrets. Navigating the session tree holds only the Secrets entered on the selected branch.
- When the lifetime ends, or the Secret is forgotten, its key is deleted, so the session's copy can never be decrypted again. Keys are deleted by a timer, before any tool call once expired, and when a session starts. After that the session file is safe to share as far as Pi Secret is concerned.
- This does not protect against someone who can read your disk while a Secret is held: the key file and the session file sit on the same machine.

Child Agents, such as Minimal Subagents children in the same Pi process, can use Secrets their root session holds, through the process-wide registry in `@ian-pascoe/pi-utils` ([ADR-0008](../../docs/adr/0008-secret-redaction-registry-in-pi-utils.md)). They cannot ask for new ones or forget the root's.

## Limitations

- **Interactive terminal only**: `secret_ask` fails in print, JSON, and RPC modes and in Child Agents, because only Pi's terminal UI can show a masked prompt.
- **Running processes keep their environment**: `PI_SECRET_NAME` is unset when a Secret expires or is forgotten, but a terminal or server started while it was held keeps its copy until it exits.
- **Streaming output**: Pi shows a running tool's partial output live, before the final result is redacted, so a command that prints a Secret can show it on screen until its result arrives. The stored result and the provider never see it.
- **Other extensions' hooks**: the arguments object Pi passes to later `tool_call` and `tool_result` handlers holds the resolved value, and a `tool_result` handler that runs before Pi Secret's sees unredacted output. Pi Guardian redacts its own copy (ADR-0008).
- **Values the agent or user write themselves**: Pi Secret scrubs provider requests, but a value typed into the chat is still saved in the session file as typed. Likewise, a user shell command such as `!env` prints the `PI_SECRET_*` variables to the screen and records them in the session.
- **Calls another extension blocks**: Pi skips `tool_result` for a blocked call, so if an extension loaded after Pi Secret blocks a call and quotes its resolved arguments in the reason, that text is not redacted.
- **One value under two names**: redaction names the Secret entered last with that value.
- **Other transformations**: a value the agent reverses, hashes, splits, compresses, or prints only in part is not recognized, so it is not redacted. Redaction is a safety net for accidental output, not a defence against a command built to reveal a Secret.
- **Mentioning the prefix**: any `PI_SECRET_NAME` word in a call's arguments counts as a reference, so text that only mentions an unheld one, such as `env | grep PI_SECRET_X`, is blocked. The bare prefix names no Secret, so `env | grep PI_SECRET_` runs, and its output is redacted.
- **`{{secret:NAME}}` in shell commands** puts the value on the command line, where `ps` can see it; prefer `$PI_SECRET_NAME`.
