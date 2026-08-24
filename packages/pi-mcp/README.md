# @ian-pascoe/pi-mcp

Pi MCP makes [Pi](https://github.com/earendil-works/pi) an MCP Host for named local and remote MCP Servers. It supports the core protocol with automatic current/legacy negotiation; it does **not** support MCP Standard Extensions. In particular, Tasks are deferred indefinitely.

## Install

Pi loads the extension directly from TypeScript. From this repository, install the collection and select its source entrypoint:

```bash
pi install git:github.com/ian-pascoe/pi-extensions
```

For a filtered Git installation, include this path in the package's `extensions` list:

```json
"packages/pi-mcp/src/index.ts"
```

The `pi-mcp` executable is compiled into the npm tarball, not into a Git checkout. After `@ian-pascoe/pi-mcp` is published, install the package with Pi and use its supplied binary:

```bash
pi install npm:@ian-pascoe/pi-mcp
pi-mcp --help
```

Until publication, do not add `npm:@ian-pascoe/pi-mcp` to `.pi/settings.json`. Workspace and Git installs use the source extension; build the local CLI explicitly when needed:

```bash
pnpm --filter @ian-pascoe/pi-mcp build:cli
node packages/pi-mcp/dist/pi-mcp-cli.js --help
```

Requires Node.js 22.19 or newer and a compatible Pi installation.

## Configure servers

Put only an `mcp` object in Pi's normal global or trusted project `settings.json`. There is no separate MCP configuration file.

```json
{
  "mcp": {
    "connectTimeoutMs": 10000,
    "requestTimeoutMs": 60000,
    "retry": {
      "maxRetries": 2,
      "initialDelayMs": 1000,
      "maxDelayMs": 30000,
      "backoffFactor": 1.5
    },
    "servers": {
      "local-docs": {
        "command": "node",
        "args": ["./tools/docs-mcp.mjs"],
        "cwd": ".",
        "environment": { "DOCS_TOKEN": "${DOCS_TOKEN}" }
      },
      "remote-docs": {
        "url": "https://mcp.example.com/mcp",
        "headers": { "X-Workspace": "${WORKSPACE_ID}" },
        "auth": { "type": "oauth", "scopes": ["tools.read"] }
      }
    }
  }
}
```

A **Server Definition** is named by its `servers` key. It is either:

- a local `stdio` definition: `command`, optional `args`, `cwd`, and `environment`; or
- a remote `http` or explicit legacy `sse` definition: `url`, optional `headers`, and optional `auth`.

Exactly one of `command` and `url` is required. `stdio` is the default for `command`; Streamable HTTP is the default for `url`. Remote URLs must be absolute HTTP(S) URLs. Remote definitions cannot contain process fields, and local definitions cannot contain headers or authentication fields. `enabled` defaults to `true`.

Authentication is omitted for anonymous access, or is one of:

```json
{ "type": "none" }
{ "type": "bearer", "token": "${MCP_TOKEN}" }
{
  "type": "oauth",
  "clientId": "optional-client-id",
  "clientSecret": "${MCP_CLIENT_SECRET}",
  "redirectUri": "http://127.0.0.1:19876/mcp/oauth/callback",
  "scopes": ["tools.read", "resources.read"]
}
```

`none` disables OAuth discovery. Bearer authentication supplies the Authorization header and cannot be combined with a configured `Authorization` header. OAuth supports discovery, Client ID Metadata Documents when configured, Dynamic Client Registration where necessary, refresh tokens, and persisted PKCE/state data. The default callback is the loopback URL above; custom redirects must also be HTTP loopback URLs.

### Defaults, merge, masks, and environment values

The host-wide defaults are:

| Setting                |   Default |
| ---------------------- | --------: |
| `connectTimeoutMs`     | 10,000 ms |
| `requestTimeoutMs`     | 60,000 ms |
| `retry.maxRetries`     |         2 |
| `retry.initialDelayMs` |  1,000 ms |
| `retry.maxDelayMs`     | 30,000 ms |
| `retry.backoffFactor`  |       1.5 |
| shutdown budget        |  5,000 ms |

Global and project `mcp` objects merge top-level timeout and retry fields. A project Server Definition replaces the whole global definition with the same name; it does not field-merge it. A project definition of `null`, or an inherited definition written as `{ "enabled": false }`, masks the global definition. Removing or enabling the project entry reveals the global definition again.

`${NAME}` expands in every string **value** in a Server Definition, using Pi's process environment. Keys are never expanded, values are expanded once only, and a missing variable makes the merged MCP configuration invalid without exposing the secret value. Unknown fields and invalid settings are rejected with path-qualified errors; Pi continues to start with MCP disabled.

## Commands

`/mcp` accepts every command below. The standalone `pi-mcp` binary accepts the first eight only.

| Command                                                                   | Surface | Purpose                                                                                                                                                 |
| ------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list [--json]`                                                           | both    | List effective definitions, provenance, enabled/masked state, auth type, and stored-auth presence; `--json` is standalone-only and list never connects. |
| `add [-l] <name> <url> …`                                                 | both    | Add or replace a remote definition.                                                                                                                     |
| `add [-l] <name> … -- <command> [args…]`                                  | both    | Add or replace a local stdio definition.                                                                                                                |
| `remove [-l] [--logout] <server>`                                         | both    | Remove a definition, optionally removing its stored credentials.                                                                                        |
| `enable [-l] <server>` / `disable [-l] <server>`                          | both    | Change enabled state.                                                                                                                                   |
| `auth <server> [--no-open] [--callback URL \| --code CODE --state STATE]` | both    | Run an explicit OAuth authorization flow.                                                                                                               |
| `logout <server>` / `logout --all --force`                                | both    | Remove one server's credentials, or explicitly reset corrupt auth storage.                                                                              |
| `test <server> \| --all [--json]`                                         | both    | Connect temporary clients and close them without disturbing live connections; `--json` is standalone-only.                                              |
| `status`                                                                  | `/mcp`  | Show live connection state.                                                                                                                             |
| `reconnect <server>`                                                      | `/mcp`  | Reconnect one live server.                                                                                                                              |
| `prompt <server> <prompt> [--arg NAME=VALUE]…`                            | `/mcp`  | Run an MCP Prompt.                                                                                                                                      |
| `subscribe <server> <uri>` / `unsubscribe <server> <uri>`                 | `/mcp`  | Manage Resource subscriptions.                                                                                                                          |
| `logs [server] [--level LEVEL]`                                           | `/mcp`  | Read retained server logs.                                                                                                                              |

Mutations default to global scope. `-l` or `--local` selects project scope and is allowed only when Pi has saved trust for that project. The standalone CLI also accepts `--approve`/`-a` or `--no-approve`/`-na` to override project trust for one invocation. In a running Pi session, add/enable persists first and then connects in the background; disable/remove persists first and then disconnects. A failed connection never rolls back the setting.

For a remote server, `add` accepts repeated `--header NAME=VALUE`, `--transport http|sse`, and the OAuth/bearer flags `--auth`, `--token`, `--client-id`, `--client-secret`, `--redirect-uri`, and repeated `--scope`. For a local server, use repeated `--environment NAME=VALUE` (or `--env`) and optional `--cwd` before `--`.

OAuth is always explicit: the authorization URL is printed before a best-effort browser launch. Use `--no-open` for remote/headless use, then provide a full callback URL with `--callback`, or a verified `--code` and `--state` pair. The host permits one active authorization flow per process and validates callback state, issuer, resource, and loopback redirect values.

## What the model can use

Every advertised MCP **Server Tool** becomes an individual Pi tool named:

```text
mcp__<server>__<tool>
```

Names are sanitized for Pi and get a deterministic hash suffix only when they collide. The original server/tool names and annotations remain diagnostics; annotations do not grant permission or alter execution.

Pi also registers these fixed tools, only when a connected server supports Resources:

```text
list_mcp_resources
list_mcp_resource_templates
read_mcp_resource
```

There is no generic raw-MCP request tool or protocol gateway. Prompts, authentication, subscriptions, status, reconnect, and logs remain `/mcp` operations rather than model tools.

Input and output schemas are retained as the Server advertised them. Pi structurally validates Server Tool schemas and validates mutated tool input before calling the server. On Pi 0.84.2 there is no public provider-schema compatibility preflight: a model provider can reject an otherwise valid exact MCP JSON Schema, which can fail that model turn. Pi MCP deliberately does not maintain a provider matrix, rewrite schemas, inspect Pi internals, or rewrite provider payloads to hide that limitation.

## Host behavior

Enabled servers connect in the background at session start, so Pi startup and TUI rendering do not wait for a process or network connection. Each session owns its clients, transports, children, listeners, timers, retries, subscriptions, logs, and private files. Current MCP peers are negotiated automatically and legacy 2025-era peers remain supported. Streamable HTTP never silently falls back to SSE.

The host maps the core protocol surface:

- tools, Resources, Resource Templates, Prompts, completion, and Server Instructions;
- sampling with Pi's active model and credentials, returning server-executable tool-use blocks;
- roots (the current Pi working directory), elicitation, logging, progress, and cancellation; and
- current multi-round input requests (bounded to ten rounds) plus legacy server-initiated callbacks.

Interactive callbacks are request-scoped. Headless environments decline interaction rather than hanging; background work never opens a dialog or browser and never starts a model turn. Resource changes queue a provenance-labelled notice for the next turn; the host does not fetch or inject resource content automatically.

Before the first model request, Pi waits only for the bounded initial connection deadline, then freezes one deterministic **Instruction Snapshot**. Its Server Instructions bytes stay unchanged for the session; instructions from later connections appear only after reload or a new session.

Failures stay isolated to the affected Server Definition. Status is one of `disabled`, `connecting`, `connected`, `needs_auth`, `needs_client_registration`, `retrying`, or `failed`. Retryable startup failures and unexpected closes use the shared capped exponential policy. Authentication, invalid configuration, unsupported protocol, disable, and shutdown do not retry. After retries are exhausted, use reconnect, reload, or a new session.

Catalog lists are cached for the session, aggregate at most 1,000 pages, reject repeated cursors, and invalidate on their matching MCP notifications. Server Tool additions/replacements take effect immediately. Pi has no public deregistration API, so removed tools are deactivated until reload.

## Output, persistence, and reload

Text and images map to Pi-native content. Embedded text Resources and Resource Links become provenance-labelled text. Structured content is visible as labelled JSON and retained in tool details. Unsupported audio and binary Resources are saved as private, mode-safe session files rather than discarded.

All model-facing text uses Pi's 2,000-line / 50-KB limit. Oversized complete output is retained in a private Result Spill and the returned content includes its path. Per-server stderr and MCP logging retain only the newest 256 KB. Stdio stdout is protocol framing only; stderr and MCP logs do not write directly to TUI, JSON, or RPC output.

Desired Resource subscriptions and expanded Prompt messages are persisted as versioned Pi custom entries and replay only on the active session branch. Connections and logs are ephemeral. Reload closes the old session generation and its dormant tool definitions, then creates a clean generation; shutdown awaits owned cleanup.

OAuth data lives in a strict, URL-and-client-identity-bound `mcp-auth.json` under Pi's agent directory, protected with mode `0600`. Settings and auth writes use a bounded lock plus atomic replacement. Malformed auth storage is not overwritten by ordinary operations; use the explicit reset command.

## Security boundaries

A project Server Definition can launch an arbitrary local executable with Pi's permissions. Treat project MCP settings as executable configuration: review the command, arguments, working directory, and environment before trusting a project or approving a project-local mutation.

Pi MCP owns no permission or approval policy for server tools, Resources, Prompts, or sampling. Another Pi extension may govern the surrounding tool call. Elicitation and OAuth are protocol interactions, not permission grants. Resolved environment values, bearer tokens, OAuth credentials, callback values, and persisted auth bytes are redacted from settings/auth errors and are not intentionally emitted to logs or results.

## License

MIT
