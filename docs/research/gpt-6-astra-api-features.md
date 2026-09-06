# GPT-6 Astra API features and Pi compatibility

**Date:** 2026-09-05

**Question:** Does Pi use GPT-6 Astra's new API features, and could an extension package add them?

## Conclusion

Pi can select `gpt-6-astra`, uses the Responses wire format, and its public OpenAI provider already requests Astra's 30-minute prompt-cache lifetime when long retention is selected. It does **not** currently implement Astra's three harness-facing additions: async tool execution overlap, true mid-response steering, or `configuration_update` reasoning changes.

A package is realistic for `configuration_update`, and a custom provider package could implement mid-turn steering with substantial transport/session work. Native async tool calling is also feasible in principle as a package owning async scheduling and provider serialization. The public ExtensionAPI does not expose the executable tool registry, but this repository already uses a capability-gated private AgentSession bridge for CodeMode. Reusing that approach could avoid a Pi fork, at the cost of version-sensitive integration; upstream support would remove that cost. This feasibility has not been verified with an async implementation. Misalignment monitoring and default prompt caching are server features, not features a plugin turns on.

| Feature                 | Server does automatically                              | Harness must do                                                                                                                   | Current Pi / package outlook                                                                                                         |
| ----------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Async tool calling      | Lets Astra continue after emitting an async call       | Mark eligible tools async; run jobs; retain pending-call state; return results against original `call_id`; schedule continuations | Not used. A package can own async scheduling and use the existing private tool-registry bridge; not a public-hooks-only integration. |
| Mid-turn steering       | Queues steering and creates a continuation             | Keep a Responses WebSocket open; send/consume steering events; reconcile tool results, disconnects, and transcripts               | Not used. Possible through an extension-owned custom provider, but it is a substantial provider/session implementation.              |
| `configuration_update`  | Applies durable effort override                        | Append the item in the correct history position while leaving request-level effort unchanged                                      | Not used. Feasible as a small provider/request adapter plus UI/command state.                                                        |
| Prompt caching          | Caching is enabled by default                          | Preserve prefixes; optionally select breakpoints/key/TTL; observe usage                                                           | Already partly used: Pi sends `prompt_cache_options.ttl: "30m"`; no package is needed for ordinary caching.                          |
| Misalignment monitoring | Monitors covered Responses requests and may block them | Handle the specific error safely; optionally operate a signed webhook receiver                                                    | Automatically applicable on covered server requests. A local plugin cannot enable it.                                                |

## Exact wire requirements and limits

### 1. Async tool calling

Declare `async: true` on a **function** or **custom** tool. The corresponding `function_call` or `custom_tool_call` output item also carries `async: true`. The application still starts and owns the background job; OpenAI does not execute it. When ready, send a later Responses request with the latest `previous_response_id` and a `function_call_output` or `custom_tool_call_output` using the **original** `call_id`. A response may contain both the async call and independent assistant output. With streaming, dispatch once the complete call item arrives. [OpenAI: Async tool calling](https://developers.openai.com/api/docs/guides/async-tool-calling)

A wait operation is not built in. If desired, the harness defines an ordinary synchronous wait tool, assigns conversation-unique task handles, maps each handle to its original `call_id`, and returns completed async outputs before the wait tool's status output. [OpenAI: Async tool calling — Add a wait tool](https://developers.openai.com/api/docs/guides/async-tool-calling#add-a-wait-tool)

Compatibility limits:

- Astra and later only.
- Only application-run function/custom tools; not hosted built-in tools.
- Use direct tool calls, not Programmatic Tool Calling.
- In Responses multi-agent mode, do not combine async tools with parallel tool calls.

This is mostly **harness work**: job lifetime, concurrent tool execution, latest-response tracking, output ordering, cancellation, retries, and transcript correctness.

### 2. Mid-turn steering

Steering requires `gpt-6-astra` over a **WebSocket connection to the Responses API**. After `response.created`, send on the same connection:

```json
{
  "type": "response.steer",
  "previous_response_id": "resp_1",
  "input": "New user instruction"
}
```

Only `type`, `previous_response_id`, and `input` are accepted. `input` is a string or nonempty array of supported user messages. `response.steer.accepted` means queued, not applied. The server finishes the current output item and hosted-tool work, may end the original response as `response.incomplete` with reason `steered`, and automatically creates a continuation inheriting the original request settings. The client must keep reading; it must **not** send another `response.create` merely because steering was accepted. [OpenAI: Mid-turn steering](https://developers.openai.com/api/docs/guides/steering)

If client tool output or approval is required, the server emits `response.steer.pending` with `required_input`. Return that input through `response.create` on the same socket, with the original response as `previous_response_id`; do not resend the accepted steer. The server implicitly prepends it. [OpenAI: Steering — Return tool results or approval](https://developers.openai.com/api/docs/guides/steering#return-tool-results-or-approval)

Steering cannot rewrite bytes already delivered, undo actions, or cancel started tools. Queued steers are connection-local and are not stored with the response; after disconnect, the harness must reconcile recorded steering with response history before replaying. Handle `response.steer.failed` codes including `invalid_input`, `steering_not_supported`, `response_not_found`, and `too_many_pending_steers`. [OpenAI: Steering — failures](https://developers.openai.com/api/docs/guides/steering#handle-failures-and-disconnects)

The underlying WebSocket endpoint is `wss://api.openai.com/v1/responses`. WebSocket `response.create` mirrors HTTP create except transport fields such as `stream` and `background`; ordinary continuations send only new items plus `previous_response_id`. Connections last up to 60 minutes. [OpenAI: WebSocket mode](https://developers.openai.com/api/docs/guides/websocket-mode)

This requires both **server support and harness transport/state work**.

### 3. Change reasoning with `configuration_update`

Append this input item before the next user message in HTTP Responses `input` or WebSocket `response.create`:

```json
{
  "type": "configuration_update",
  "reasoning": { "effort": "high" }
}
```

Keep request-level `reasoning.effort` at its original value. The item changes effective effort for that and later responses until another update, while preserving the prior cacheable prefix. Preserve updates with `previous_response_id`, or replay them at their original positions in manually managed history. The response's `reasoning.effort` field still reports the request-level value, not the effective update. [OpenAI: Change reasoning mid-conversation](https://developers.openai.com/api/docs/guides/reasoning#change-reasoning-mid-conversation)

Compatibility limits:

- Only `gpt-6-astra`.
- Only standard, single-agent mode.
- It changes reasoning effort only.
- Adjacent `configuration_update` items are rejected.
- Do not combine them with automatic compaction or automatic truncation.
- `/responses/compact` rejects histories containing them. Explicit `compaction_trigger` is allowed; after compaction, append a fresh update.
- Astra supports `low`, `medium`, `high`, `xhigh`, and `max`; `none` returns HTTP 400. [OpenAI: GPT-6 Astra model](https://developers.openai.com/api/docs/models/gpt-6-astra), [OpenAI: Reasoning effort](https://developers.openai.com/api/docs/guides/reasoning#reasoning-effort)

These compaction exclusions concern OpenAI's API compaction/truncation features. Pi's own summarization is separate, but a package still needs to reset or reconstruct its effort-update history after Pi compaction, branching, and resume.

This is primarily **request/history shaping in the harness**.

### 4. Prompt caching

Prompt caching is enabled by default for supported models. Astra follows the GPT-5.6-and-later rules: minimum 1,024 visible input tokens; cache writes cost 1.25× uncached input and reads 0.1×; `prompt_cache_options.ttl` supports only `"30m"`, which is also the default. A matching reuse refreshes the lifetime. [OpenAI: Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)

Controls:

- Implicit mode places a breakpoint at the latest eligible message.
- `prompt_cache_options.mode: "explicit"` disables implicit placement; mark supported input content blocks with `prompt_cache_breakpoint: {"mode":"explicit"}`.
- Top-level `instructions` cannot hold an explicit breakpoint; place reusable instructions in an `input_text` block of a developer message.
- At most four cache writes are created per request; in implicit mode, the implicit write consumes one slot.
- `prompt_cache_key` influences routing but neither pins a machine nor guarantees a hit.
- Observe `usage.input_tokens_details.cached_tokens` and `cache_write_tokens`.

The caching itself is **automatic server behavior**. Prefix stability, explicit breakpoints, routing keys, and measurement are optional harness optimizations. `configuration_update` exists specifically to avoid invalidating the prefix when effort changes.

### 5. Misalignment monitoring

OpenAI asynchronously monitors Astra reasoning/actions in consequential contexts. Coverage depends on API and conversation continuity: [OpenAI: Misalignment monitoring](https://developers.openai.com/api/docs/guides/safety-checks/misalignment-monitoring)

| Request path                                                          | Monitoring behavior                                                                                    |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Responses using persisted reasoning, WebSockets, or OpenAI compaction | Monitored; the system can identify the conversation and stop further execution.                        |
| Responses using none of those                                         | Monitored; configured webhooks can receive alerts, but automatic conversation stopping is unavailable. |
| Chat Completions                                                      | Not covered by this monitoring system.                                                                 |

A blocked request returns HTTP `403`, type `invalid_request_error`, code `misalignment_policy_violation`; streaming clients must also accept an error after output has begun. The harness must stop dispatching actions, avoid automatic retry, retain relevant IDs/records, and surface the error for review. There is no general resume mechanism, and a block does not undo completed actions.

Optional project alerts arrive as `safety.alert.created`. After webhook signature verification and acknowledgement, retrieve `GET /v1/safety/alerts/{alert_id}` with a same-project API key carrying `api.safety.alerts.read`. Webhooks do not enable automatic stopping and do not constitute a complete audit log.

Monitoring is a **server safeguard**. Robust error handling and an optional webhook service are application responsibilities.

## Public API key versus ChatGPT/Codex endpoint

The public contracts above are documented for the OpenAI Platform Responses API and examples authenticate `https://api.openai.com/v1/responses` or `wss://api.openai.com/v1/responses` with `OPENAI_API_KEY`. Astra supports both `/v1/responses` and text generation through `/v1/chat/completions`, but Astra tool calling requires Responses; Chat Completions also lacks the new steering/configuration item protocols and misalignment-monitoring coverage described above. [OpenAI: Astra migration](https://developers.openai.com/api/docs/guides/latest-model/gpt-6-astra#migration-quickstart), [OpenAI: model endpoints](https://developers.openai.com/api/docs/models/gpt-6-astra#endpoints)

ChatGPT sign-in and API-key access are separate product/auth/data-policy surfaces. Astra is listed for both ChatGPT Credits and API Access, but feature availability depends on rollout, sign-in method, and client. [OpenAI Codex: Authentication](https://developers.openai.com/codex/auth), [OpenAI Codex: Models](https://developers.openai.com/codex/models#gpt-6-astra)

The first-party Codex client shows that a Responses-compatible WebSocket exists on its ChatGPT route: the built-in OpenAI provider accepts either API-key or ChatGPT authentication, uses Responses, and advertises WebSocket support; it separately defines `https://chatgpt.com/backend-api/codex`, and its WebSocket handshake adds Codex metadata, a beta header, and optional attestation. [OpenAI Codex source: provider, immutable ref](https://github.com/openai/codex/blob/588b781ab4924ce7352488394028e63d74cf807f/codex-rs/model-provider-info/src/lib.rs#L37-L40), [provider auth/WebSocket flags](https://github.com/openai/codex/blob/588b781ab4924ce7352488394028e63d74cf807f/codex-rs/model-provider-info/src/lib.rs#L140-L148), [built-in provider](https://github.com/openai/codex/blob/588b781ab4924ce7352488394028e63d74cf807f/codex-rs/model-provider-info/src/lib.rs#L390-L420), [handshake headers](https://github.com/openai/codex/blob/588b781ab4924ce7352488394028e63d74cf807f/codex-rs/core/src/client.rs#L1269-L1302)

That source is evidence of **first-party Codex support**, not a public compatibility promise for third-party clients. The public API docs do not state that arbitrary ChatGPT/Codex bearer clients may use all five raw protocols unchanged. A Pi implementation should therefore treat the paths separately:

- **OpenAI API-key provider:** the documented `/v1/responses` contracts apply.
- **ChatGPT/Codex provider:** use only behavior explicitly supported by that provider/client, or capability-probe it; do not assume API-key endpoint wire/auth/header behavior is interchangeable.

## Pi status (upstream audit at `da840b6216578c2a571d0374ac6a2091a83f9d91`)

The installed Pi version is 0.85.1; the audited upstream ref matched the live upstream head on 2026-09-05 apart from changelog-only commits since the release.

- Pi's OpenAI and OpenAI-Codex catalogs already list Astra as a Responses model with efforts through `max` and prompt-cache metadata. For the pseudo-level `minimal`, the public OpenAI catalog maps to `null`, while OpenAI-Codex maps it to `low`; both map `off` to `null`.
- The public OpenAI provider uses SDK/SSE Responses. It sends `store: false`, `prompt_cache_options.ttl: "30m"` for long retention, and request-level reasoning effort on every call. It has no `configuration_update` support. [Pi source: `openai-responses.ts`](https://github.com/earendil-works/pi/blob/da840b6216578c2a571d0374ac6a2091a83f9d91/packages/ai/src/api/openai-responses.ts#L91-L99), [request construction](https://github.com/earendil-works/pi/blob/da840b6216578c2a571d0374ac6a2091a83f9d91/packages/ai/src/api/openai-responses.ts#L305-L354)
- The agent loop consumes a complete model stream, then awaits the tool batch, then drains steering messages. Consequently Pi's current “steering” is between complete response/tool batches, not Astra `response.steer`, and ordinary awaited tool executions cannot overlap inference. Extensions can already return a background-job handle immediately and deliver results later; that is a separate application-level pattern, not native async-call support. [Pi source: `agent-loop.ts`](https://github.com/earendil-works/pi/blob/da840b6216578c2a571d0374ac6a2091a83f9d91/packages/agent/src/agent-loop.ts#L212-L261)
- The OpenAI-Codex provider caches a WebSocket and sends sequential `response.create` continuations with `previous_response_id`, but does not send `response.steer`. [Pi source: `openai-codex-responses.ts`](https://github.com/earendil-works/pi/blob/da840b6216578c2a571d0374ac6a2091a83f9d91/packages/ai/src/api/openai-codex-responses.ts#L1459-L1548)
- Extensions can mutate provider requests and register a custom provider, so `configuration_update` and a custom steering transport are possible. The public ExtensionAPI exposes tool metadata, not the main scheduler or every executable handler. That rules out a trivial public-hooks-only async adapter, not a package using internal integration. [Pi extension docs](https://github.com/earendil-works/pi/blob/da840b6216578c2a571d0374ac6a2091a83f9d91/packages/coding-agent/docs/extensions.md), [Pi custom-provider docs](https://github.com/earendil-works/pi/blob/da840b6216578c2a571d0374ac6a2091a83f9d91/packages/coding-agent/docs/custom-provider.md)

### Follow-up: an async package does not require a fork

`packages/pi-codemode/src/pi-agent-session-capture.ts` already captures the owning AgentSession and validates its private `_toolRegistry`. `packages/pi-codemode/src/pi-tool-bridge.ts` invokes the effective wrapped handlers with argument validation and before/after hooks. This version-sensitive approach is explicitly accepted in [CodeMode ADR-0002](../../packages/pi-codemode/docs/adr/0002-bridge-pi-registered-tools.md). It removes the registry-access obstacle for a package willing to use the same compatibility boundary; it does not itself implement async Responses scheduling.

## Minimal implementation recommendation

1. Keep existing prompt caching; add measurement or explicit breakpoints only after observed misses justify it.
2. Add `configuration_update` first as a small Astra/public-Responses request adapter, with the documented compaction exclusions.
3. For an async package, prototype a custom provider/stream adapter with the existing capability-gated tool-registry bridge. It must preserve native async call metadata, dispatch each call once, retain pending results across Responses requests, and prevent Pi's normal serializer from inventing `No result provided` results. Verify hooks, cancellation, session history, and compatibility with CodeMode before claiming transparent support. Upstream scheduler support remains the cleaner long-term option.
4. Add steering only as a provider-level WebSocket feature with explicit capability gating for public API versus ChatGPT/Codex routes.
5. Add `misalignment_policy_violation` handling to the provider/agent error path; operate webhook ingestion outside the local extension if project alerts are required.

## Primary sources

- [Using GPT-6 Astra](https://developers.openai.com/api/docs/guides/latest-model/gpt-6-astra)
- [GPT-6 Astra model reference](https://developers.openai.com/api/docs/models/gpt-6-astra)
- [Async tool calling](https://developers.openai.com/api/docs/guides/async-tool-calling)
- [Mid-turn steering](https://developers.openai.com/api/docs/guides/steering)
- [WebSocket mode](https://developers.openai.com/api/docs/guides/websocket-mode)
- [Reasoning models / `configuration_update`](https://developers.openai.com/api/docs/guides/reasoning#change-reasoning-mid-conversation)
- [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- [Misalignment monitoring](https://developers.openai.com/api/docs/guides/safety-checks/misalignment-monitoring)
- [Migrate to Responses](https://developers.openai.com/api/docs/guides/migrate-to-responses)
- [Codex authentication](https://developers.openai.com/codex/auth)
- [Codex models](https://developers.openai.com/codex/models#gpt-6-astra)
- [OpenAI Codex source at `588b781`](https://github.com/openai/codex/tree/588b781ab4924ce7352488394028e63d74cf807f)
- [Pi source at `da840b6`](https://github.com/earendil-works/pi/tree/da840b6216578c2a571d0374ac6a2091a83f9d91)
