# Add the `@ian-pascoe/pi-mcp` package

**Status:** Approved

## Outcome

Add a public Pi extension package that makes Pi a complete MCP Host for configured local and remote MCP Servers. The extension loads from source TypeScript, while the same package publishes a compiled `pi-mcp` executable for persistent configuration and authentication outside Pi.

Read before implementation:

- [`../../AGENTS.md`](../../AGENTS.md)
- [`../../CONTEXT-MAP.md`](../../CONTEXT-MAP.md)
- [`../../packages/pi-mcp/CONTEXT.md`](../../packages/pi-mcp/CONTEXT.md)
- all package decisions in [`../../packages/pi-mcp/docs/adr/`](../../packages/pi-mcp/docs/adr/)
- [`../agents/domain.md`](../agents/domain.md)
- [`../adr/0002-publish-pi-extensions-as-source-typescript.md`](../adr/0002-publish-pi-extensions-as-source-typescript.md), with the package-specific CLI exception in ADR-0005
- [Pi extension lifecycle, tools, commands, events, custom entries, and output truncation](../../.repos/pi/packages/coding-agent/docs/extensions.md)
- [Pi settings and project trust](../../.repos/pi/packages/coding-agent/docs/settings.md)
- [Pi RPC interaction limits](../../.repos/pi/packages/coding-agent/docs/rpc.md)
- [official TypeScript SDK v2 client documentation](https://ts.sdk.modelcontextprotocol.io/v2/client/)
- [2026-07-28 MCP specification](https://modelcontextprotocol.io/specification/2026-07-28)
- OpenCode's MCP reference at [`../../.repos/opencode/packages/opencode/src/mcp/`](../../.repos/opencode/packages/opencode/src/mcp/) and [`../../.repos/opencode/packages/opencode/src/cli/cmd/mcp.ts`](../../.repos/opencode/packages/opencode/src/cli/cmd/mcp.ts)

Use the package glossary's MCP Host, MCP Client, MCP Server, Server Definition, Server Tool, Server Instructions, and Instruction Snapshot terms in identifiers, tests, errors, and user documentation.

## Boundaries

- Use the stable `@modelcontextprotocol/client` v2 package and its public exports. Import Node stdio only from `@modelcontextprotocol/client/stdio`. Import no private SDK module.
- Support current protocol negotiation plus legacy 2025-era peers; stdio, Streamable HTTP, and explicitly configured legacy SSE; and every agreed core capability. Standard Extensions are deferred indefinitely.
- Register Server Tools individually and three fixed resource tools. Provide no generic raw-request or protocol-gateway tool.
- Register `/mcp` for all persistent and live operations. Publish `pi-mcp`; current Pi cannot register or intercept a literal `pi mcp` process subcommand.
- Read only the package-owned `mcp` object in Pi's trust-aware global and project `settings.json` layers. Add no standalone MCP config, setup wizard, server catalog, installer, or automatic settings watcher.
- Start enabled servers in the background without delaying Pi startup or TUI rendering. Own every process, transport, listener, timer, subscription, and retry within one Pi session generation.
- Keep permission and sampling-approval policy outside this package. Elicitation and OAuth remain protocol interactions.
- Preserve exact MCP schemas and content. Use Pi's standard output limits, private session files, and Result Spills rather than silently dropping data.
- Keep invalid MCP settings, authentication files, and runtime failures inside the extension boundary; Pi must still start and render.
- Guarantee the `pi-mcp` executable for workspace builds and the scoped npm package. A monorepo Git installation loads the source extension but exposes no workspace-package bin or generated `dist`.
- Prepare public version `0.1.0`. Add no bootstrap Changeset and run no publish command.

## Established implementation facts

- Pi 0.84.2 exposes tool activation but no public tool deregistration. Catalog removals deactivate tools until reload discards dormant definitions.
- Pi accepts structurally valid JSON Schema tool definitions without a TypeBox symbol and validates such calls through its JSON Schema fallback.
- Pi 0.84.2 exposes no public provider-schema compatibility preflight. Validate Server Tool schemas structurally and register exact schemas without a provider matrix, private Pi import, schema rewrite, or provider-payload inspection. A provider may reject an otherwise valid schema and fail that model turn; document and test this contained limitation rather than blocking implementation.
- The repository already has the required no-dependency locked-write pattern in `packages/pi-adaptive-thinking/src/adaptive-thinking-lifecycle.ts` and private Result Spill/stderr ownership patterns in `packages/pi-lsp/src/lsp-session-files.ts` and `packages/pi-dap/src/dap-session-files.ts`.
- `dist/` is repository-ignored. `prepack` must compile the CLI into the tarball; generated JavaScript does not enter source control.

## Intended module ownership

Start with these owners. Merge only when the result remains cohesive; add no generic `config.ts`, `types.ts`, `utils.ts`, service locator, transport interface with one implementation, or forwarding-only module.

| File                        | Sole owner                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `src/index.ts`              | Thin Pi extension default export                                                                             |
| `src/pi-mcp-extension.ts`   | Pi registration, session lifecycle, Instruction Snapshot, command/UI adapters, and custom-entry replay       |
| `src/pi-mcp-settings.ts`    | Strict wire schemas, layer merging, defaults, Server Definition validation, and secret-tracked interpolation |
| `src/mcp-settings-store.ts` | Global/project paths, project trust, locked atomic settings mutation, and scope provenance                   |
| `src/mcp-command.ts`        | Shared `pi-mcp` and `/mcp` grammar, validation, operation dispatch, and deterministic output                 |
| `src/pi-mcp-cli.ts`         | Executable entrypoint, process exit codes, `--json`, and terminal I/O                                        |
| `src/mcp-auth-store.ts`     | Mode-`0600` OAuth state, URL/client binding, locked atomic persistence, and corruption handling              |
| `src/mcp-oauth.ts`          | SDK OAuth provider, discovery, loopback callback, pasted callback validation, and browser launch             |
| `src/mcp-server-client.ts`  | One Server Definition's SDK Client, transport, callbacks, capability calls, cancellation, and close          |
| `src/mcp-host.ts`           | Session-owned server registry, statuses, retries, catalogs, caches, subscriptions, and shutdown              |
| `src/mcp-tool-catalog.ts`   | Server Tool naming/activation, fixed resource tools, exact schemas, and operation dispatch                   |
| `src/mcp-content.ts`        | MCP-to-Pi content conversion, structured output, truncation, and Result Spill presentation                   |
| `src/mcp-session-files.ts`  | Private Result Spills, unsupported binary content, and bounded per-server stderr/log tails                   |

Keep domain types and constants beside their owner. Export a symbol only when another owner consumes it, and give each export a one-line constraint comment.

## Implementation sequence

### 1. Establish the baseline, package shell, and SDK tracer

Record:

```bash
git status --short
git rev-parse HEAD
pnpm verify
pnpm changeset:status
```

Expected starting changes are `CONTEXT-MAP.md`, `packages/pi-mcp/CONTEXT.md`, the five package ADRs, and this plan. Stop for review if unrelated source changes exist.

Create:

- `packages/pi-mcp/package.json` for public `@ian-pascoe/pi-mcp@0.1.0`, with the repository's metadata, Node engine, `pi.extensions: ["./src/index.ts"]`, and `bin.pi-mcp: "./dist/pi-mcp-cli.js"`;
- package files limited to `src`, generated `dist`, `README.md`, `LICENSE`, and `package.json`;
- runtime `@modelcontextprotocol/client@^2.0.0` and the existing Pi/TypeBox wildcard peers;
- development-only `@modelcontextprotocol/server@^2.0.0` for current-protocol fixtures and `@modelcontextprotocol/sdk@^1.30.0` for legacy fixtures;
- strict package `tsconfig.json`, emitting `tsconfig.cli.json`, MIT `LICENSE`, README shell, thin `src/index.ts`, and inert lifecycle shell;
- `build:cli` and `prepack` scripts that emit only the CLI entrypoint's dependency graph into ignored `dist/`.

Before building runtime behavior, inspect the installed v2 package's exports and declaration files. Write tracer tests that prove:

1. `versionNegotiation: "auto"` reaches a 2026-07-28 server and falls back to a legacy server;
2. root HTTP transports and `@modelcontextprotocol/client/stdio` load from the declared dependency;
3. the CLI compiles with a preserved shebang and runs `--help` under plain Node from a temporary packed install;
4. the Pi source entrypoint loads without opening a process, socket, file, timer, or browser.

Prove Pi accepts a structurally valid non-TypeBox JSON Schema through its public registration and call-validation paths. Do not introduce a provider matrix, silently simplify schemas, import private Pi modules, or inspect and rewrite provider payloads. Provider rejection of an otherwise valid exact schema remains a documented Pi 0.84.2 limitation and may fail that model turn.

Use no private SDK import and no copied v1 client implementation.

**Complete when:** workspace install and typecheck succeed, the current/legacy tracers are green, `npm pack` contains a runnable `dist/pi-mcp-cli.js`, and loading `src/index.ts` is inert.

### 2. Resolve settings and implement safe mutation stores

Implement `pi-mcp-settings.ts` and `mcp-settings-store.ts` before launching servers. Reuse the trust-aware settings-reader pattern from Pi LSP/DAP, and reuse the exclusive-create, bounded-retry, stale-lock pattern from Pi Adaptive Thinking. Keep the critical section limited to read → parse → modify → mode-safe temporary write → rename.

Test with real temporary files and no module mocks:

- absent `mcp`, defaults, strict unknown-field rejection, and path-qualified errors;
- global/project top-level field merging and complete Server Definition replacement;
- inherited `{ "enabled": false }` and `null` masks, complete disabled definitions, enable/remove reveal behavior, and provenance;
- command/URL exclusivity; `stdio`, `http`, and `sse` consistency; `environment`; all `auth` variants; and host-wide retry/deadline bounds;
- exact retry defaults `2`, `1000`, `30000`, and `1.5`; zero-retry behavior; 10-second connection and 60-second request defaults; progress reset; and fixed five-second shutdown;
- `${VAR}` resolution in every string leaf, missing variables, non-recursive environment values, no key/non-string interpolation, and resolved-secret tracking;
- invalid merged configuration disabling MCP without rejecting `session_start`;
- global default mutation and `-l` project mutation through Pi's saved trust plus approve/no-approve behavior;
- contended and stale locks, concurrent writers preserving unrelated settings, mode-safe atomic replacement, and a failed write retaining the original document.

Implement `mcp-auth-store.ts` on the same locked atomic primitive. Parse the file strictly, preserve refresh/client/PKCE/state/discovery data, bind entries to the SHA-256 resolved URL and client identity, use mode `0600`, and refuse mutation of malformed storage except an explicit reset path.

**Complete when:** every settings/auth byte becomes a validated value or exact contained error, concurrent mutations lose no unrelated data, secret values never appear in errors, and no invalid input can prevent Pi from starting.

### 3. Build one real MCP Client tracer and the session Host

Implement `mcp-server-client.ts`, `mcp-session-files.ts`, and the narrow registry core of `mcp-host.ts`. Use the official Client and transports directly; add no transport wrapper hierarchy.

Exercise real child/server fixtures for:

- stdio startup with the SDK safe default environment plus configured `environment`, Pi cwd resolution, protocol-only stdout, bounded stderr, and descendant cleanup;
- Streamable HTTP current discovery/calls and explicitly configured legacy SSE, with no automatic transport fallback;
- current per-request envelopes and legacy initialize/session behavior through `versionNegotiation: "auto"`;
- concurrent non-blocking session startup, bounded connect timeout, close-on-failed-connect, and five-second shutdown followed by forced process termination;
- request timeout reset by progress, AbortSignal cancellation, connection-close detection, and idempotent close;
- parallel request isolation so sampling, elicitation, progress, cancellation, and Pi context cannot bleed between calls to one server;
- retry eligibility, capped exponential timing, exhausted failure, explicit reconnect, and no retry for auth/config/protocol/disabled/shutdown outcomes;
- status transitions: `disabled`, `connecting`, `connected`, `needs_auth`, `needs_client_registration`, `retrying`, and `failed`;
- 1,000-page bounds, duplicate-cursor rejection, session-private cache hints, and list/change invalidation;
- 256-KB per-server log/stderr retention and private session-file cleanup.

Connection failure remains local to one server. `session_start` schedules work and returns before any fixture connects. `session_shutdown` detaches notifications and awaits every owned cleanup path.

**Complete when:** all three transports pass their negotiated contract, startup/TUI-facing lifecycle never waits for connection, every retry/state transition is deterministic under a fake clock, and no test leaves a child, socket, stream, listener, timer, or session directory alive.

### 4. Implement bearer and OAuth authentication end to end

Implement `mcp-oauth.ts` against the SDK's `OAuthClientProvider` surface and `mcp-auth-store.ts`.

Cover:

- omitted auth connecting anonymously and detecting standards-compliant OAuth challenges without opening a browser;
- `auth.type: "none"` suppressing discovery and `bearer` owning the Authorization header;
- rejection of simultaneous bearer auth and configured Authorization headers;
- explicit OAuth with optional client ID, secret, scopes, and redirect URI; CIMD when supported and DCR compatibility otherwise;
- fixed `127.0.0.1:19876` callback defaults, custom loopback callbacks, explicit port-collision errors, state/issuer/resource validation, and one active authorization per process;
- printed authorization URL before best-effort platform browser launch, `--no-open`, full pasted callback URLs, code-plus-state input, and bare-code rejection;
- refresh persistence, SDK-preserved refresh tokens, URL/client changes invalidating credentials, same-URL aliases sharing credentials, logout, remove-without-logout, and `remove --logout`;
- malformed auth storage, mode `0600`, concurrent refresh writers, callback timeout/cancellation, and complete secret redaction from SDK/HTTP errors.

Treat `logout --all --force` as the explicit corrupt-store reset; no ordinary auth mutation may replace malformed bytes.

Use a local HTTP OAuth fixture; require no external credentials or browser in tests. Browser launch is an injected `execFile` seam patterned after Pi's private opener and uses no shell interpolation.

**Complete when:** authentication works from both CLI and injected runtime seams, background connection never starts interaction, remote paste completes with CSRF checks, token refresh survives restart, and no test/log/result contains a credential or resolved secret.

### 5. Expose tools, resources, prompts, instructions, and content

Implement `mcp-tool-catalog.ts`, `mcp-content.ts`, and the corresponding Host catalog behavior.

Server Tools:

- register `mcp__<server>__<tool>` names, sanitize provider-invalid characters, and add deterministic hashes only to collisions;
- preserve original names and untrusted annotations in diagnostics;
- pass exact JSON Schema 2020-12 definitions without external-reference dereferencing or lossy rewriting;
- recompute activation on initial catalog load, `tools/list_changed`, and server reconnect/disconnect;
- register additions/replacements immediately and deactivate removals/dormant definitions through `setActiveTools()` without changing other extensions' active tools; include already-registered foreign names in deterministic collision handling;
- validate mutated call input again before `callTool`, bridge cancellation/progress, validate advertised output schemas, and keep accompanying content on validation failure.
- map MCP `isError` to a Pi tool error while retaining text, images, structured content, bounded details, and Result Spill references.

Fixed capability tools:

```text
list_mcp_resources
list_mcp_resource_templates
read_mcp_resource
```

Activate resource tools only while a connected server supports resources. Keep fixed schemas stable. Address prompts as `/mcp prompt <server> <prompt>` with SDK completion backing argument completion; persist the role-faithful result and immediately begin the model turn.

Map text and images natively; embedded text resources and links to provenance-labelled text; unsupported audio/binary to mode-safe private session files; structured content to labelled model-visible JSON plus bounded details. Apply 2,000-line/50-KB truncation to every model-facing result and retain complete oversized output as a Result Spill.

Start connection work at `session_start`, but wait only in `before_agent_start` for the bounded first-request deadline. Freeze one deterministic Server Instructions string for the session and reuse its exact bytes every turn; late instructions wait for reload/new session.

**Complete when:** a real server's tools/resources/templates/prompts/instructions work through Pi's registered surfaces, catalog notifications update only relevant active tools, role/content fidelity is tested, unsupported content remains readable by path, and repeated turns use a byte-identical Instruction Snapshot.

### 6. Fulfil Host callbacks and subscriptions

Implement current multi-round-trip and legacy callback handlers through `mcp-server-client.ts`, then complete Host subscription persistence.

Host callbacks:

- sampling uses `ctx.modelRegistry.complete()` with Pi's active model/credentials, respects `maxTokens`, treats model preferences as advisory, returns request-scoped `tool_use` blocks for the server to execute, and advertises no deprecated sampling context inclusion;
- form elicitation names the requesting server, supports the specification's flat primitive/enum schemas, validates values, and permits review/edit/decline/cancel; URL elicitation shows the full URL/domain, performs no prefetch, and opens only after explicit consent;
- roots returns only the current Pi cwd;
- logging/progress/cancellation route to bounded logs, active Pi tool updates, and AbortSignals without injecting background content into model context;
- the SDK automatic input-required driver uses the fixed ten-round bound; headless modes decline interaction rather than hanging.

Persist versioned custom entries for desired resource subscriptions. Persist each MCP Prompt result as a Pi custom message whose details contain the validated MCP message array; a `context` hook replaces that custom message at the same branch position with role-faithful messages. Replay only the active branch on start/resume and resubscribe without replaying logs or connections. Resource updates queue only a provenance-labelled next-turn notice; they never fetch or inject content automatically. Logs remain ephemeral.

Test current input-required and legacy server-initiated flows, sampling text/image/tool-use output, all elicitation actions/modes, headless decline, roots, progress/cancel, subscribe/unsubscribe/update/list-changed, branch replay, reload rebinding, and ten-round failure.

**Complete when:** every advertised Host capability has a faithful current and legacy proof, no background work opens UI or triggers a model turn, every resumed state belongs to the active branch, and no method bypasses public SDK validation.

### 7. Implement the shared command surface and compiled CLI

Complete `mcp-command.ts`, `pi-mcp-cli.ts`, and `/mcp` registration. Use one parser/result model for both surfaces; inject only terminal/UI, settings, auth, temporary-test, and live-Host adapters.

Support exactly:

```text
list
add
remove
enable
disable
auth
logout
test
status
reconnect
prompt
subscribe
unsubscribe
logs
```

The standalone CLI exposes the first eight persistent/offline operations; `/mcp` exposes all of them. Bare `/mcp` shows status and concise help. Both default mutations to global scope and accept `-l`/`--local`. `add` accepts a remote URL or local command after `--`, with the agreed repeated remote/local/auth flags. Missing arguments show usage rather than opening a wizard.

Ensure:

- offline `pi-mcp list` starts no server and reports effective config, provenance, enabled/masked state, auth type, and stored-auth presence;
- standalone `test <server>` and explicit `--all` use temporary clients and close them; `/mcp test` never disturbs live clients;
- `/mcp` add/enable persist then connect in the background; disable/remove persist then disconnect/deactivate; failed connection does not roll back settings; Instruction Snapshot remains frozen;
- project mutations use Pi trust semantics; read-only standalone commands support `--json`; mutation output remains human-readable;
- auth prints URLs, handles browser/no-open/paste, and logout/reset are explicit;
- `/mcp logs [server] [--level LEVEL]` reads the bounded tail and uses the standard logging-level request only when the server advertises it;
- settings/auth/test failures produce stable nonzero CLI exits while extension commands notify without throwing through Pi.

Compile from `src/pi-mcp-cli.ts` with no Pi runtime import in the emitted graph. Spawn the built executable in tests from workspace and a packed install.

**Complete when:** both interfaces pass the same command contract table, every mutation has a real-file and live-Host check, standalone commands work under plain Node, and `/mcp` remains usable after invalid config or runtime failure.

### 8. Finish package and repository integration

Complete `packages/pi-mcp/README.md` as the caller-facing authority for installation, settings schema/defaults/merging/interpolation, transports, auth and remote callbacks, all CLI and `/mcp` commands, model-facing tools, full Host capability mappings, retries/timeouts, project trust, output/Result Spills, reload/lifecycle, status/errors, and security boundaries. State that project Server Definitions can launch arbitrary local executables with Pi's permissions.

Update every repository authority:

- root `package.json` extension order;
- `.pi/settings.json` workspace/Git filters, enabling only the workspace copy and adding no configured MCP Server; defer the `npm:@ian-pascoe/pi-mcp` filter until the package is published;
- root README package table, selectable Git path, and focused checks;
- `test/extension-entrypoints.test.ts` expected path/order/count from eleven to twelve;
- `scripts/check-package-packs.mjs` workspace count and package-specific allowance for `dist/pi-mcp-cli.js`, `bin`, `build:cli`, and `prepack`, while retaining the source-only contract for every other package;
- package-pack smoke that runs the installed `pi-mcp --help` and verifies no undeclared runtime module is used;
- `scripts/check-git-install.mjs` extension path/count from eleven to twelve while explicitly testing only source extension loading, not the npm-only package bin;
- `docs/releases.md` from nine to ten scoped bootstrap packages and eleven to twelve trusted-publishing packages;
- `pnpm-lock.yaml` and any root contract counts/messages.

Retain the approved context and ADR wording. Add no initial Changeset. Generate no tracked `dist` file and run no publish command.

**Complete when:** workspace, packed npm install, and clean production Git copy load the twelfth source entrypoint; the packed scoped package also runs `pi-mcp`; all counts and docs agree; and tarball validation permits the CLI exception only for Pi MCP.

### 9. Run the proof gate

Run in order:

```bash
pnpm format
pnpm --filter @ian-pascoe/pi-mcp typecheck
pnpm --filter @ian-pascoe/pi-mcp test
pnpm --filter @ian-pascoe/pi-mcp build:cli
pnpm test:load
pnpm pack:check
pnpm git-install:check
pnpm verify
pnpm changeset:status
git diff --check
git status --short
```

Inspect the final diff and prove:

- all agreed Server Definition, auth, merge, masking, interpolation, retry, timeout, and trust rules have direct tests;
- current and legacy protocol paths, all three transports, and every advertised core capability have real wire-level tests;
- startup and TUI rendering never wait for MCP, while the first model request waits only for the bounded Instruction Snapshot deadline;
- no background path opens a browser/dialog, changes the system prompt, triggers a model turn, prints stderr, or leaks a resolved secret;
- parallel requests to one server retain independent callbacks, progress, cancellation, and Pi contexts;
- no raw MCP-request tool, permission layer, settings watcher, server catalog/installer, HTTP-to-SSE fallback, per-server retry/timeout, provider matrix, private Pi import, schema rewrite, provider-payload inspection, or deprecated sampling-context advertisement entered the package;
- every process, transport, request, retry, poll, subscription, callback server, listener, timer, file lock, temporary file, and session file has one owner and tested cleanup;
- generated CLI JavaScript is ignored in the working tree, present and executable in the tarball, and imports no Pi-only source graph;
- package files, root metadata, `.pi/settings.json`, release counts, lockfile, tarball checks, Git-install checks, and load tests agree on twelve packages/extensions;
- the working tree contains only the approved package, docs/ADRs/plan, lockfile, and required repository integration; and
- no publish command ran.

**Complete when:** `pnpm verify` is green, all real protocol/auth/CLI tracers are green, packed and Git-install paths are green, every checklist item has test or diff evidence, and `pnpm changeset:status` contains no bootstrap entry for `@ian-pascoe/pi-mcp`.

## Pause

Do not begin implementation until this plan is reviewed and explicitly approved in a later turn.
