import { onTestFinished, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import type { Api, Model, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import { getCurrentTools } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { streamSimple as anthropicStream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as codexStream } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { streamSimple as openaiStream } from "@earendil-works/pi-ai/api/openai-responses";
import {
  activeFixture,
  longSessionStream,
  type PrivateRequest,
} from "./fixtures/observer-harness.js";
import { AdvisorObserver } from "../src/advisor-observer.js";
import { readAdvisorSettings, type AdvisorConfig } from "../src/advisor-settings.js";

/** A Codex access token only needs the account claim Pi's adapter reads. */
const codexToken = `x.${Buffer.from(
  JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account" } }),
).toString("base64")}.y`;

/** The request-body fields these tests read; the rest of Pi's payload stays opaque. */
const payloadSchema = Type.Object(
  {
    prompt_cache_key: Type.Optional(Type.String()),
    prompt_cache_retention: Type.Optional(Type.String()),
    input: Type.Optional(Type.Array(Type.Unknown())),
    tools: Type.Optional(Type.Array(Type.Unknown())),
  },
  { additionalProperties: true },
);
type Payload = Static<typeof payloadSchema>;

interface Request {
  advisor: boolean;
  /** A native compaction summary of the Advisor Session: a request without tools. */
  summary: boolean;
  /** The exact bytes the adapter would send, from `JSON.stringify`. */
  json: string;
  body: Payload;
  options: SimpleStreamOptions | undefined;
}

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: The fixture provider registers each model under the API its adapter serves, so the adapter chosen by `model.api` matches the model's type; offline SDK tests exercise all three. */
function adapterFor(model: Model<Api>, context: TranscriptContext, options: SimpleStreamOptions) {
  switch (model.api) {
    case "openai-responses":
      return openaiStream(model as Model<"openai-responses">, context, options);
    case "anthropic-messages":
      return anthropicStream(model as Model<"anthropic-messages">, context, options);
    case "openai-codex-responses":
      return codexStream(model as Model<"openai-codex-responses">, context, options);
    default:
      return undefined;
  }
}
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

/**
 * Build each request's real provider payload with Pi's own adapter, after every
 * `before_provider_request` handler, and stop the adapter before it would use the network.
 */
function recordPayloads(requests: Request[]) {
  globalThis.advisorObserverTest.request = (model, context, options) => {
    const tools = getCurrentTools(context.messages);
    const advisor = tools.some((tool) => tool.name === "advisor_report");
    const summary = tools.length === 0;
    const recorded: SimpleStreamOptions = {
      ...options,
      apiKey: model.api === "openai-codex-responses" ? codexToken : "offline",
      transport: "sse",
      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: Pi's `onPayload` contract is an opaque provider body; it is serialized and schema-checked before any use.
      onPayload: async (body, payloadModel) => {
        const next: unknown = (await options?.onPayload?.(body, payloadModel)) ?? body;
        const json = JSON.stringify(next);
        requests.push({
          advisor,
          summary,
          json,
          body: Value.Parse(payloadSchema, JSON.parse(json)),
          options,
        });
        throw new Error("payload recorded");
      },
    };
    const stream = adapterFor(model, context, recorded);
    if (stream) void stream.result();
    else requests.push({ advisor, summary, json: "{}", body: {}, options });
  };
}

/** Run one observed request (two model calls) under a provider; the Advisor is optional. */
async function run(
  provider: string,
  config?: Partial<AdvisorConfig>,
  prompts = ["Request 1."],
  stream: Parameters<typeof longSessionStream>[2] = {
    result: (id) => `ok ${id}`,
    isError: () => false,
  },
) {
  const privateRequests: PrivateRequest[] = [];
  globalThis.advisorObserverTest = longSessionStream({ Request: 1 }, privateRequests, stream);
  const requests: Request[] = [];
  recordPayloads(requests);
  const session = await activeFixture({ compaction: { enabled: false, keepRecentTokens: 1_000 } }, [
    fileURLToPath(new URL("./fixtures/provider-extension.ts", import.meta.url)),
  ]);
  const model = session.modelRuntime.getModel(provider, `offline-${provider}`);
  if (!model) throw new Error(`Missing ${provider} fixture model`);
  await session.setModel(model);
  if (config) {
    const observer = new AdvisorObserver(
      session,
      { ...readAdvisorSettings(session).settings, enabled: true, catchUpThreshold: 1, ...config },
      "headless-root",
    );
    globalThis.advisorObserverTest.settled = () => observer.settled();
    onTestFinished(() => observer.dispose());
  }
  for (const prompt of prompts) await session.prompt(prompt);
  return {
    session,
    advisor: requests.filter((request) => request.advisor),
    observed: requests.filter((request) => !request.advisor && !request.summary),
    summaries: requests.filter((request) => request.summary),
  };
}

const cacheControls = (json: string) => json.match(/"cache_control":\{[^}]*\}/g) ?? [];
/** Observed bodies, as the exact bytes sent, with the per-run session id and directory named. */
const bytes = (
  session: { sessionId: string; sessionManager: { getCwd(): string } },
  requests: Request[],
) =>
  requests.map((request) =>
    request.json
      .replaceAll(session.sessionId, "<session>")
      .replaceAll(session.sessionManager.getCwd(), "<cwd>"),
  );

it("asks OpenAI for 24h prompt cache retention on Advisor requests only", async () => {
  const baseline = await run("openai");
  const withAdvisor = await run("openai", {});
  expect(withAdvisor.advisor.length).toBeGreaterThan(0);
  for (const request of withAdvisor.advisor) {
    expect(request.options?.cacheRetention).toBe("long");
    expect(request.body.prompt_cache_retention).toBe("24h");
    expect(request.body.prompt_cache_key).toEqual(expect.any(String));
  }
  // The observed agent's requests stay byte-identical to a run without the Advisor.
  expect(baseline.observed).toHaveLength(2);
  expect(bytes(withAdvisor.session, withAdvisor.observed)).toEqual(
    bytes(baseline.session, baseline.observed),
  );
  for (const request of withAdvisor.observed) {
    expect(request.options?.cacheRetention).toBeUndefined();
    expect(request.body).not.toHaveProperty("prompt_cache_retention");
  }
});

it("keeps Anthropic on the default cache lifetime unless the Advisor opts in", async () => {
  const baseline = await run("anthropic");
  const standard = await run("anthropic", {});
  expect(standard.advisor.length).toBeGreaterThan(0);
  for (const request of standard.advisor) {
    expect(request.options?.cacheRetention).toBeUndefined();
    expect(cacheControls(request.json).length).toBeGreaterThan(0);
    expect(cacheControls(request.json).join()).not.toContain("ttl");
  }
  expect(bytes(standard.session, standard.observed)).toEqual(
    bytes(baseline.session, baseline.observed),
  );

  const extended = await run("anthropic", { anthropicLongCache: true });
  for (const request of extended.advisor) {
    const controls = cacheControls(request.json);
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) expect(control).toContain('"ttl":"1h"');
  }
  expect(extended.observed).toHaveLength(2);
  expect(bytes(extended.session, extended.observed)).toEqual(
    bytes(baseline.session, baseline.observed),
  );
});

it("sends no retention field to Codex, whose backend takes none", async () => {
  const { advisor } = await run("openai-codex", { anthropicLongCache: true });
  expect(advisor.length).toBeGreaterThan(0);
  for (const request of advisor) {
    expect(request.options?.cacheRetention).toBeUndefined();
    expect(request.body).not.toHaveProperty("prompt_cache_retention");
    expect(request.body).not.toHaveProperty("prompt_cache_options");
  }
});

it("sends the first and second Review of a new Advisor Session with the same request settings", async () => {
  // Cache proof for the Codex second-Review miss: everything but `input` is identical, and the
  // second request's input extends the first's.
  const { advisor } = await run("openai-codex", { reviewEvery: "turn" }, [
    "Request 1.",
    "Request 2.",
  ]);
  expect(advisor.length).toBeGreaterThanOrEqual(2);
  const settings = (body: Payload) => {
    const { input: _input, ...rest } = body;
    return JSON.stringify(rest);
  };
  const inputs = advisor.map((request) => request.body.input ?? []);
  for (const [index, request] of advisor.entries()) {
    if (index === 0) continue;
    expect(settings(request.body)).toBe(settings(advisor[0]?.body ?? {}));
    const previous = inputs[index - 1] ?? [];
    expect(JSON.stringify(inputs[index]?.slice(0, previous.length))).toBe(JSON.stringify(previous));
  }
  expect(advisor[0]?.body.tools).toBeDefined();
  expect(advisor[0]?.body.prompt_cache_key).toBe(advisor[1]?.body.prompt_cache_key);
});

it("leaves providers without a retention opt-in at their default", async () => {
  const requests: Request[] = [];
  const privateRequests: PrivateRequest[] = [];
  globalThis.advisorObserverTest = longSessionStream({ Request: 1 }, privateRequests, {
    result: (id) => `ok ${id}`,
    isError: () => false,
  });
  recordPayloads(requests);
  const session = await activeFixture();
  const observer = new AdvisorObserver(
    session,
    { ...readAdvisorSettings(session).settings, enabled: true, catchUpThreshold: 1 },
    "headless-root",
  );
  globalThis.advisorObserverTest.settled = () => observer.settled();
  onTestFinished(() => observer.dispose());
  await session.prompt("Request 1.");
  expect(requests.some((request) => request.advisor)).toBe(true);
  for (const request of requests) expect(request.options?.cacheRetention).toBeUndefined();
});

it.each([
  ["openai", {}],
  ["anthropic", { anthropicLongCache: true }],
])(
  "keeps native compaction summaries of the Advisor Session uncached on %s",
  async (provider, config) => {
    const prompts = Array.from({ length: 6 }, (_, index) => `Request ${index + 1}.`);
    const { advisor, summaries } = await run(
      provider,
      { ...config, reviewEvery: "request", maxSessionTokens: 4_000 },
      prompts,
      {
        result: (id) => `result ${id} ${"x".repeat(8_000)}`,
        isError: () => false,
        reportContextTokens: true,
      },
    );
    expect(summaries.length).toBeGreaterThan(0);
    for (const request of summaries) {
      expect(request.options?.cacheRetention).toBe("none");
      expect(request.json).not.toContain("cache_control");
      expect(request.body).not.toHaveProperty("prompt_cache_retention");
      expect(request.body).not.toHaveProperty("prompt_cache_key");
    }
    expect(advisor.length).toBeGreaterThan(0);
    for (const request of advisor) expect(request.options?.cacheRetention).toBe("long");
  },
);
