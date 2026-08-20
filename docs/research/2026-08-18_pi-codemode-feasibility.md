# Pi Code Mode feasibility

**Date:** 2026-08-18
**Question:** Can a Pi extension run OpenAI Codex's stateful Code Mode JavaScript REPL over Pi's already-registered tools, without changing upstream Pi or reimplementing Pi's built-in tools? Monkey-patching Pi is allowed.

## 2026-08-19 Deno-native update

The user rejected the Codex host dependency after this report. The earlier
`quickjs-emscripten` spike is historical validation only: it established that
Pi handler capture, detached-call draining, timeout, and cancellation merit
end-to-end proof. It is not part of the selected runtime.

Node 22.19 rejects native TypeScript below `node_modules`. Deno 2.9.5 executes
the same installed source with `--node-modules-dir=none`, and dynamically
imports `Blob` modules marked `application/typescript`. The selected design
therefore adds the official exact `deno@2.9.5` npm dependency and runs one
permission-denied Deno subprocess per CodeMode Session. Deno itself transpiles
and executes Cells without type checking. The package-local `typescript@6.0.3`
parser matches Deno's bundled compiler and only plans source-range declaration
rewrites.

**Selected verdict:** an independently implemented Code Mode is feasible with
Deno-native TypeScript Cells and the same transient `AgentSession` capture
described below. Pi handler closures remain in the parent Node process and cross
a bounded standard-stream JSON bridge; they are never moved into Deno. The
historical Codex-host sections below remain comparison material, not the
selected runtime.

The production proof must cover Notebook Binding persistence, native TypeScript
execution, nested `executionMode` scheduling, streamed nested updates, exact
`terminate` propagation, and bounded shutdown when a registered tool ignores
`AbortSignal`.

## Verdict

**Yes, with a version-pinned private bridge.** It is not possible through Pi's public `ExtensionAPI` alone.

The viable design is:

1. Run OpenAI's standalone `codex-code-mode-host` process.
2. Register a small model-facing execute/wait surface in Pi.
3. Snapshot Pi's current active tool definitions into the host request.
4. Route host delegate callbacks to the **same `ToolDefinition` objects already held by the current `AgentSession`**.
5. Mirror Pi's preparation, validation, permission hooks, result hooks, cancellation, and execution-mode rules in a generic dispatcher.

This does **not** reimplement `read`, `bash`, `edit`, `write`, extension tools, or MCP tools. It implements only the unavoidable transport and dispatch adapter between two existing registries.

The blocker to a public-only implementation is narrow but real: `pi.getAllTools()` exposes names, descriptions, schemas, and source metadata, not executable closures. The executable definitions live on `AgentSession`, which an extension is not given. A transient `AgentSession` capture monkey patch can bridge that gap without changing upstream source.

| Interpretation                                           | Feasible?                     | Notes                                                                                          |
| -------------------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------- |
| Use the real Codex V8 REPL and the real Pi tool handlers | **Yes**                       | Standalone host plus private session capture                                                   |
| No upstream Pi changes                                   | **Yes**                       | Extension-only monkey patch                                                                    |
| No built-in-tool reimplementation                        | **Yes**                       | Delegate to existing definitions                                                               |
| Use only documented `ExtensionAPI` methods               | **No**                        | No execute-by-name or executable definitions API                                               |
| Zero adapter code                                        | **No**                        | IPC, schema mapping, lifecycle, and result conversion are inherently required                  |
| Exact Pi top-level tool-loop semantics for nested calls  | **Mostly, not automatically** | Hooks can be mirrored; transcript/provider events remain nested under the outer Code Mode call |

## What “Code Mode REPL” means here

This report refers to OpenAI Codex's current Code Mode runtime, not Cloudflare `@cloudflare/codemode` or UTCP `@utcp/code-mode`.

Codex documents the outer operation as raw JavaScript evaluated in a fresh V8 isolate. Nested tools are methods on `tools`; the isolate has no Node API, filesystem, network, or console. It provides `text`, `image`, `store`, `load`, `notify`, timers, `ALL_TOOLS`, and `yield_control`. A yielded cell remains live and is resumed or terminated through `wait`.[^codex-description]

Despite each cell using a fresh isolate, stored values are session-scoped. The Code Mode protocol calls a session “durable” and requires cells in one session to share stored values while separate sessions remain isolated.[^codex-session]

## The Codex runtime is externally usable

### Stable release boundary

OpenAI Codex release `0.147.0` includes a separate `codex-code-mode-host` executable. Its CLI supports `stdio`, `stdio://`, and `ws://IP:PORT` transports.[^host-cli-stable] The stable stdio protocol is straightforward:

- JSON payloads;
- four-byte little-endian length prefix;
- 64 MiB maximum frame;
- request IDs and delegate-request IDs;
- protocol-version/capability handshake.[^host-codec][^host-messages]

The V1 execute request carries:

- the outer tool-call ID;
- JavaScript source;
- yield/output limits;
- a list of enabled tool definitions, each with a JavaScript name, original tool identity, description, kind, input schema, and optional output schema.[^host-payload]

During execution the host sends `tool/invoke` delegate requests and accepts `tool/result` or error responses. It also sends notification, cancellation, initial-response, and cell-closed messages.[^host-messages]

This is exactly the boundary a Pi extension needs: Codex owns V8 and cell state; Pi owns actual capabilities.

### Current `main` boundary

OpenAI's current `main` additionally defines a language-neutral gRPC service with `OpenSession`, `SubscribeToToolCalls`, `CompleteToolCall`, `Execute`, `Wait`, `CancelWait`, and `Terminate`. Its comments explicitly describe “stateful JavaScript execution” whose nested calls are delegated to the session owner.[^grpc-proto]

That gRPC service is useful future direction, but it was not present in the locally verified `0.147.0` host binary. An implementation intended to work now should pin the stable V1 stdio protocol instead of coding against mutable `main`.

### Distribution

The generic `@openai/codex` npm package exposes only the `codex` CLI wrapper. Platform packages contain the `vendor` directory, including both `codex` and `codex-code-mode-host`; official GitHub releases also publish host assets by target.[^codex-package][^codex-release]

Recommended binary policy:

1. support an explicit configured host path;
2. optionally resolve the companion beside an installed Codex binary;
3. otherwise download one **pinned release asset with a pinned checksum** into Pi's cache;
4. never fetch mutable `latest` at execution time.

The Codex source and host are Apache-2.0. Preserve the upstream license/notice if redistributing the host or source.

## Pi's tool registry: what is public and what is not

### Public extension surface

Pi 0.84.2 exposes:

- `registerTool(definition)`;
- `getActiveTools(): string[]`;
- `getAllTools(): ToolInfo[]`;
- `setActiveTools(names)`.[^pi-extension-api]

`ToolInfo` is discovery metadata. `AgentSession.getAllTools()` constructs it from each definition's name, description, parameters, prompt guidelines, and source metadata. It deliberately omits `execute`, `prepareArguments`, rendering, and execution mode.[^pi-tool-info]

Therefore this does not work:

```text
pi.getAllTools() -> send schemas to host -> host calls back -> ???
```

There is no public `pi.executeTool(name, args)` and no public method returning executable tool definitions.

### The executable objects do exist centrally

`AgentSession` maintains:

- `_baseToolDefinitions` for built-ins;
- `_toolDefinitions` for the effective definition registry;
- `_toolRegistry` for wrapped `AgentTool` instances.[^pi-session-fields]

On refresh, Pi starts with built-in definitions, overlays extension/SDK tools by name, wraps them, and rebuilds the active registry.[^pi-registry-refresh] Consequently the effective definition is the right seam: it already reflects built-in overrides and extension precedence.

`AgentSession.getToolDefinition(name)` is a public class method returning the effective `ToolDefinition`, but `ExtensionAPI` does not expose the `AgentSession` instance.[^pi-tool-info]

### Minimal monkey patch

The least invasive capture is transient:

1. Import the exported `AgentSession` class.
2. During `session_start`, temporarily replace `AgentSession.prototype.getAllTools` with a wrapper that records `this` and calls the original.
3. Call this extension's `pi.getAllTools()` synchronously.
4. Restore the original prototype method in `finally`.
5. Verify the captured object's method/registry shapes before using it.

Why this works: Pi binds `ExtensionAPI.getAllTools` to an arrow that calls `this.getAllTools()` on the owning session.[^pi-runtime-binding] The temporary call therefore reveals the exact current session without a lasting patch.

This should be version-gated to the tested Pi range and fail closed when capture or shape verification fails. Do not leave a global prototype patch installed.

## Recommended architecture

```text
Model
  |
  |  codemode({ code }) / codemode_wait({ cell_id, ... })
  v
Pi extension outer tool
  |
  |  V1 length-prefixed JSON over stdio
  v
codex-code-mode-host (sandboxed V8, session/cell state)
  |
  |  tool/invoke(name, JSON input)
  v
Generic Pi nested dispatcher
  |
  |  captured AgentSession.getToolDefinition(name)
  v
Existing Pi ToolDefinition.prepareArguments / execute
```

### 1. Model-facing tools

The portable implementation should register two ordinary Pi function tools:

- `codemode({ code, yield_time_ms?, max_output_tokens? })`
- `codemode_wait({ cell_id, yield_time_ms?, max_tokens?, terminate? })`

This runs the real Code Mode host but avoids provider-specific freeform-tool conversion. Any model that can call a normal Pi tool can use it.

If exact Codex wire compatibility is required, the outer tool names/shape are `exec` as a raw freeform custom tool and `wait` as a function tool. Pi's normal `ToolDefinition` API only describes JSON-schema function tools, so exact raw `exec` requires provider request/response adaptation. That is possible by wrapping/patching the provider, but it is a separate, provider-specific feature and not required to run the REPL.

Using prefixed names also avoids collisions: this repository already has an extension tool named `wait`. If exact `exec`/`wait` names are chosen, duplicate-registration behavior and extension ordering must be treated as configuration errors rather than silently replacing another tool.

### 2. Tool catalog snapshot

For each outer execute call:

1. Read `pi.getActiveTools()`.
2. Resolve each name through the captured session's `getToolDefinition`.
3. Exclude the Code Mode outer tools to prevent recursion.
4. Convert each TypeBox schema directly to the host's JSON-schema field.
5. Preserve the raw Pi name in a reversible lookup map.
6. Normalize the JavaScript method name using Codex's identifier rule.
7. Reject normalization collisions instead of silently hiding one tool.

Use **active**, not merely configured, tools by default. Exposing inactive tools would bypass Pi's active-tool policy and deferred-loading behavior. Refresh the snapshot for every new execute call because tools may be registered or activated after startup.

This design naturally includes:

- built-in tools;
- built-in replacements;
- normal extension tools;
- SDK custom tools;
- MCP tools registered into Pi's registry.

It cannot include a capability that never becomes a Pi `ToolDefinition`; that is outside the stated requirement.

### 3. Nested dispatch

For a host `tool/invoke` callback:

1. Resolve the original Pi tool name from the per-cell map.
2. Re-resolve the current effective definition or reject if it changed incompatibly.
3. Apply `prepareArguments` if present.
4. Validate with Pi's existing `validateToolArguments` helper.
5. Invoke Pi's pre-tool hook and honor block/terminate decisions.
6. Execute the same tool definition with:
   - a unique nested tool-call ID;
   - the live cell's `ExtensionContext`;
   - the nested `AbortSignal`;
   - an update callback that renders progress inside the outer Code Mode call.
7. Convert thrown errors to a failed delegate response.
8. Invoke Pi's post-tool hook and apply its result overrides.
9. Convert the final result to bounded JSON for the V8 promise.

The existing tool implementation is never copied. `read` remains Pi's read; an overridden `edit` remains that override; an MCP tool remains the registered MCP closure.

### 4. Hook parity is a security requirement

Pi's normal loop does more than call `execute`:

1. find tool;
2. prepare arguments;
3. validate;
4. run `beforeToolCall`;
5. execute;
6. run `afterToolCall`;
7. emit execution/message events.[^pi-agent-loop]

`AgentSession` installs `agent.beforeToolCall` and `agent.afterToolCall` to drive extension `tool_call` and `tool_result` handlers and image normalization.[^pi-session-hooks]

Calling `ToolDefinition.execute` directly would bypass permission gates, protected-path checks, mutation-manifest checks, and result middleware implemented in those hooks. That is unacceptable as the default.

The private bridge should call the captured session's installed `agent.beforeToolCall`/`afterToolCall` callbacks with equivalent arguments. If those callback shapes or identities cannot be verified for the pinned Pi version, nested execution must fail closed.

Even with hook parity, nested calls should **not** be appended as independent provider-level tool-result messages: they are implementation details of the outer Code Mode tool. Instead, expose their progress and summaries through the outer tool's `onUpdate`/details. Extensions that rely specifically on top-level `tool_execution_*` or transcript events will not observe identical chronology. This is the main semantic difference from Pi's top-level loop.

### 5. Concurrency and execution mode

Code Mode JavaScript can use `Promise.all`, so nested callbacks may arrive concurrently. The dispatcher must honor each definition's `executionMode`:

- parallel tools may execute concurrently;
- sequential tools need a session-scoped queue;
- tool-native queues, such as Pi's file-mutation queue, remain inside the original handlers.

Ignoring `executionMode` would be another behavioral divergence from the registered Pi tool.

### 6. Result mapping

Pi tools return content blocks plus optional details/usage. Host delegate results must be JSON. A conservative generic conversion is:

- text-only result: joined text, unless structured details are explicitly JSON-safe and more useful;
- image result: `{ content, details }` with Pi image blocks converted to data URLs when necessary;
- empty result: a stable `"(no output)"` value;
- non-serializable/cyclic/oversized details: omit or truncate with an explicit marker;
- errors: failed delegate response, not a successful string containing an error.

Never expose renderer objects, contexts, credentials, streams, or arbitrary class instances across IPC.

### 7. Cancellation, progress, and yielded cells

Maintain maps keyed by session, cell, and delegate request:

- cell -> latest `ExtensionContext` and tool snapshot;
- delegate request -> `AbortController`;
- outer request -> cell ID once admitted.

Then:

- host `delegate/cancel` aborts the matching Pi tool;
- outer tool cancellation cancels the host operation, terminates the cell, and aborts in-flight delegates;
- `codemode_wait` refreshes the live `ExtensionContext` for a cell created in an earlier turn;
- `session_shutdown`, reload, switch, or process failure terminates cells and reaps the host;
- nested `onUpdate` and host notifications update the outer tool display.

Code Mode `store`/`load` state must be scoped to one Pi session. Do not reuse one host session across unrelated Pi sessions, branches, or switched session files without an explicit state policy.

## Working precedent

Installed `@howaboua/pi-codex-conversion` 3.0.16 already proves that a third-party Pi extension can:

- install/start a pinned `codex-code-mode-host`;
- speak the V1 host protocol;
- expose execute/wait behavior;
- route delegate requests;
- pass a live `ExtensionContext`, cancellation, and progress into nested tools.[^conversion-readme][^conversion-client][^conversion-adapter]

Its `toNestedTool()` adapter calls the supplied `ToolDefinition.prepareArguments` and then that exact definition's `execute` method.[^conversion-adapter]

However, its default Code Mode catalog constructs a curated Codex-shaped tool set (`exec_command`, `apply_patch`, and others). It is therefore proof of the host/adapter architecture, **not** an implementation of the requested “use every registered Pi tool without reimplementation” policy.[^conversion-catalog]

A standalone `pi-codemode` should reuse the idea, not depend on that package's private files. Its distinguishing change is registry capture plus generic wrapping instead of constructing replacement tools.

## Risks and mitigations

| Risk                          | Consequence                        | Mitigation                                                  |
| ----------------------------- | ---------------------------------- | ----------------------------------------------------------- |
| Pi private layout changes     | Session capture or dispatch breaks | Pin/test Pi versions; runtime shape probe; fail closed      |
| Host protocol changes         | IPC parse failure                  | Pin host release and V1 codec; protocol handshake           |
| Permission hooks bypassed     | Unsafe file/network operations     | Mirror before/after hooks; never fall back to raw `execute` |
| Inactive tools exposed        | Bypass Pi capability policy        | Snapshot only `getActiveTools()`                            |
| `exec`/`wait` collision       | Replaces unrelated extension tool  | Prefer prefixed outer names or reject duplicates            |
| Normalized-name collision     | Wrong tool executes                | Maintain reversible map and reject collisions               |
| Concurrent JS calls           | Violates sequential tool contract  | Queue `executionMode: "sequential"` tools                   |
| Dynamic registry changes      | Cell schema and handler diverge    | Immutable per-cell map; reject removed/incompatible tools   |
| Non-JSON tool details         | IPC failure or data leak           | Explicit bounded serializer                                 |
| Host child survives reload    | Resource leak, stale callbacks     | Session-owned process and shutdown timeout/kill             |
| Provider lacks freeform tools | Cannot use exact raw `exec` wire   | Use ordinary `{ code }` function tool                       |

## Alternatives considered

### Recreate Pi built-ins in the extension

Rejected. It violates the requirement, misses overrides, and drifts from Pi.

### Import Pi's built-in factories and create new instances

Rejected as the primary design. Although better than rewriting implementations, these are not necessarily the same configured/overridden registered instances and omit third-party tools.

### Use only `pi.getAllTools()`

Insufficient. It supplies schemas but no callable handlers.

### Spawn the normal `codex` CLI or app server

Wrong ownership boundary. That process has its own tool registry and session. The standalone Code Mode host is the narrower component designed to delegate tools back to its owner.

### Cloudflare or UTCP Code Mode

Possible in principle but unnecessary. They would still need the same Pi executable-registry bridge, while Codex already ships the requested REPL/host protocol.

### Add an upstream Pi execute-by-name API

Architecturally clean, but excluded by the requirement. If Pi later exposes executable definitions or a nested-dispatch method, replace the monkey patch with that API.

## Suggested proof gate before implementation commitment

Build a throwaway spike, not the package, that proves these five points on pinned Pi 0.84.2 and Codex host 0.147.0:

1. Transiently capture the correct `AgentSession` and recover the exact built-in `read` definition.
2. Run one host cell that calls `tools.read`, returning the real Pi result.
3. Register a temporary extension tool after startup and prove the next cell sees and calls it.
4. Install a blocking `tool_call` hook and prove the nested call is denied without executing.
5. Cancel a long-running nested tool and prove both the tool and host cell terminate and the host exits on session shutdown.

Also test normalized-name collisions, sequential tools under `Promise.all`, image output, extension reload, and an overridden built-in. If any permission-hook parity test fails, do not ship a raw-execute fallback.

## Final recommendation

Proceed with a `pi-codemode` prototype using the stable standalone host and a transient `AgentSession` capture. Keep the implementation deliberately small:

- one pinned host installer/resolver;
- one V1 stdio client;
- one generic Pi registry adapter;
- two outer tools;
- one session lifecycle owner.

Do not build another tool catalog and do not import/recreate Pi built-ins. The only justified private coupling is obtaining the effective executable definitions and invoking Pi's installed before/after hooks. Treat that seam as versioned infrastructure with a fail-closed compatibility probe.

---

## Sources

All OpenAI links below are pinned. Stable-release source is tag commit `3ed6f04f6bf8b7c46299d1cb1ff99c74ce21a51d` (`rust-v0.147.0`). Current-main gRPC evidence is commit `fde2156057c38c0227ce94c8514d04c7498df60d`. Pi links are pinned to the local reference commit `59a71b235dadb4ad0d67557a8abb0aaa093e68b4`.

[^codex-description]: OpenAI Codex, [`code-mode-protocol/src/description.rs`, stable lines 12-44](https://github.com/openai/codex/blob/3ed6f04f6bf8b7c46299d1cb1ff99c74ce21a51d/codex-rs/code-mode-protocol/src/description.rs#L12-L44).

[^codex-session]: OpenAI Codex, [`code-mode-protocol/src/session.rs`, lines 98-196](https://github.com/openai/codex/blob/3ed6f04f6bf8b7c46299d1cb1ff99c74ce21a51d/codex-rs/code-mode-protocol/src/session.rs#L98-L196).

[^host-cli-stable]: OpenAI Codex, [`code-mode-host/src/main.rs`, stable lines 3-22](https://github.com/openai/codex/blob/3ed6f04f6bf8b7c46299d1cb1ff99c74ce21a51d/codex-rs/code-mode-host/src/main.rs#L3-L22).

[^host-codec]: OpenAI Codex, [`code-mode-protocol/src/host/codec.rs`, stable lines 11-169](https://github.com/openai/codex/blob/3ed6f04f6bf8b7c46299d1cb1ff99c74ce21a51d/codex-rs/code-mode-protocol/src/host/codec.rs#L11-L169).

[^host-messages]: OpenAI Codex, [`code-mode-protocol/src/host/message.rs`, stable lines 141-327](https://github.com/openai/codex/blob/3ed6f04f6bf8b7c46299d1cb1ff99c74ce21a51d/codex-rs/code-mode-protocol/src/host/message.rs#L141-L327).

[^host-payload]: OpenAI Codex, [`code-mode-protocol/src/host/payload.rs`, stable lines 85-235](https://github.com/openai/codex/blob/3ed6f04f6bf8b7c46299d1cb1ff99c74ce21a51d/codex-rs/code-mode-protocol/src/host/payload.rs#L85-L235).

[^grpc-proto]: OpenAI Codex, [`codex.code_mode.v1.proto`, current-main lines 1-229](https://github.com/openai/codex/blob/fde2156057c38c0227ce94c8514d04c7498df60d/codex-rs/code-mode-protocol/src/grpc/codex.code_mode.v1.proto#L1-L229).

[^codex-package]: OpenAI Codex, [`codex-cli/package.json`](https://github.com/openai/codex/blob/3ed6f04f6bf8b7c46299d1cb1ff99c74ce21a51d/codex-cli/package.json) and local installed `@openai/codex@0.147.0-linux-x64/package.json` (`files: ["vendor"]`).

[^codex-release]: OpenAI Codex, [release 0.147.0 assets](https://github.com/openai/codex/releases/tag/rust-v0.147.0).

[^pi-extension-api]: Pi, [`extensions/types.ts`, lines 1263-1270 and 1356-1366](https://github.com/earendil-works/pi/blob/59a71b235dadb4ad0d67557a8abb0aaa093e68b4/packages/coding-agent/src/core/extensions/types.ts#L1263-L1270).

[^pi-tool-info]: Pi, [`agent-session.ts`, lines 905-928](https://github.com/earendil-works/pi/blob/59a71b235dadb4ad0d67557a8abb0aaa093e68b4/packages/coding-agent/src/core/agent-session.ts#L905-L928).

[^pi-session-fields]: Pi, [`agent-session.ts`, lines 345-372](https://github.com/earendil-works/pi/blob/59a71b235dadb4ad0d67557a8abb0aaa093e68b4/packages/coding-agent/src/core/agent-session.ts#L345-L372).

[^pi-registry-refresh]: Pi, [`agent-session.ts`, lines 2556-2647](https://github.com/earendil-works/pi/blob/59a71b235dadb4ad0d67557a8abb0aaa093e68b4/packages/coding-agent/src/core/agent-session.ts#L2556-L2647).

[^pi-runtime-binding]: Pi, [`agent-session.ts`, lines 2491-2497](https://github.com/earendil-works/pi/blob/59a71b235dadb4ad0d67557a8abb0aaa093e68b4/packages/coding-agent/src/core/agent-session.ts#L2491-L2497).

[^pi-agent-loop]: Pi, [`agent-loop.ts`, lines 609-767](https://github.com/earendil-works/pi/blob/59a71b235dadb4ad0d67557a8abb0aaa093e68b4/packages/agent/src/agent-loop.ts#L609-L767).

[^pi-session-hooks]: Pi, [`agent-session.ts`, lines 473-535](https://github.com/earendil-works/pi/blob/59a71b235dadb4ad0d67557a8abb0aaa093e68b4/packages/coding-agent/src/core/agent-session.ts#L473-L535).

[^conversion-readme]: Installed `@howaboua/pi-codex-conversion` 3.0.16, `README.md` lines 25-49, 114-138, and 215-217; upstream repository: [`packages/pi-codex-conversion`](https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/main/packages/pi-codex-conversion).

[^conversion-client]: Installed `@howaboua/pi-codex-conversion` 3.0.16, `src/tools/code-mode/host-client.ts`, `host-session.ts`, `host-protocol.ts`, and `delegate-runtime.ts`.

[^conversion-adapter]: Installed `@howaboua/pi-codex-conversion` 3.0.16, [`src/adapter/code-mode/nested-tool-adapter.ts`](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/main/packages/pi-codex-conversion/src/adapter/code-mode/nested-tool-adapter.ts).

[^conversion-catalog]: Installed `@howaboua/pi-codex-conversion` 3.0.16, [`src/adapter/code-mode.ts`](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/main/packages/pi-codex-conversion/src/adapter/code-mode.ts).
