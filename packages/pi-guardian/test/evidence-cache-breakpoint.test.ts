import type { Api, Model } from "@earendil-works/pi-ai";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  composePayloadHooks,
  evidenceCacheBreakpoint,
  type PayloadHook,
} from "../src/guardian-cache.js";
import {
  assessment,
  confirmedRejection,
  createGuardianHarness,
  reply,
  toolCalls,
  type CapturedReview,
} from "./fixtures/guardian-harness.js";

const anthropic = "guardian-anthropic/claude-haiku-4-5";
const managedEffort = "guardian-anthropic/claude-haiku-5-5";
const bedrock = "guardian-bedrock/anthropic.claude-haiku-4-5-20251001-v1:0";

const CacheMarker = Type.Object({ type: Type.String(), ttl: Type.Optional(Type.String()) });
const AnthropicBody = Type.Object({
  system: Type.Unknown(),
  messages: Type.Array(
    Type.Object({
      role: Type.String(),
      content: Type.Array(
        Type.Object({
          type: Type.String(),
          text: Type.Optional(Type.String()),
          cache_control: Type.Optional(CacheMarker),
        }),
      ),
    }),
  ),
});
const BedrockBody = Type.Object({
  system: Type.Unknown(),
  messages: Type.Array(
    Type.Object({
      role: Type.String(),
      content: Type.Array(
        Type.Object({ text: Type.Optional(Type.String()), cachePoint: Type.Optional(CacheMarker) }),
      ),
    }),
  ),
});
type AnthropicBody = Static<typeof AnthropicBody>;
type AnthropicBlock = AnthropicBody["messages"][number]["content"][number];
type BedrockBody = Static<typeof BedrockBody>;

/** A captured request's body, as the adapter would send it (`sent`) or built it (`built`). */
function wire<S extends TSchema>(
  schema: S,
  review: CapturedReview | undefined,
  at: "sent" | "built" = "sent",
): Static<S> {
  const text = review?.wire?.[at];
  if (text === undefined) throw new Error("Missing captured wire payload");
  const body: unknown = JSON.parse(text);
  if (!Value.Check(schema, body)) throw new Error(`Unexpected request body: ${text}`);
  return body;
}

const withoutMarker = ({ cache_control: _marker, ...block }: AnthropicBlock) => block;

/** Positions of the cache breakpoints in an Anthropic request's first message. */
function anthropicBreakpoints(body: AnthropicBody): number[] {
  const [first] = body.messages;
  return (first?.content ?? []).flatMap((block, at) => (block.cache_control ? [at] : []));
}

/** Two reviews in one session: the second's evidence extends the first's by its own turn. */
async function twoReviews(model: string, wirePayloads = true) {
  const harness = await createGuardianHarness({
    guardianSettings: { model, policy: "Staging is trusted." },
    wirePayloads,
    contextFiles: (dir) => [
      { path: `${dir}/AGENTS.md`, content: "Deploying to staging is always fine." },
    ],
  });
  harness.responses.push(
    toolCalls(["deploy", { target: "staging" }, "call-1"]),
    toolCalls(["deploy", { target: "staging-2" }, "call-2"]),
    reply("Done."),
  );
  harness.guardianReplies.push(
    assessment("low", "high", "Requested."),
    assessment("low", "high", "Requested."),
  );
  await harness.session.prompt("Deploy staging twice.");
  expect(harness.reviews).toHaveLength(2);
  return harness;
}

describe("Anthropic evidence cache breakpoint", () => {
  it("marks the last evidence block, so the next review reads the previous one's prefix", async () => {
    const harness = await twoReviews(anthropic);
    const [first, second] = harness.reviews.map((review) => wire(AnthropicBody, review));
    if (!first || !second) throw new Error("Missing reviews");
    const evidence = (body: AnthropicBody) => (body.messages[0]?.content.length ?? 0) - 1;
    const firstEvidence = evidence(first);
    const secondEvidence = evidence(second);
    expect(secondEvidence).toBeGreaterThan(firstEvidence);

    // Each request marks its last evidence block, and the adapter's own tail: the Reviewed Call.
    expect(anthropicBreakpoints(first)).toEqual([firstEvidence - 1, firstEvidence]);
    expect(anthropicBreakpoints(second)).toEqual([secondEvidence - 1, secondEvidence]);
    // The system prompt's breakpoint is the third; Anthropic allows four.
    expect(JSON.stringify(first.system)).toContain("cache_control");

    // The cached prefix is the system prompt and the content up to the breakpoint. Cache
    // markers are not part of what Anthropic matches, so compare without them.
    const prefix = (body: AnthropicBody, blocks: number) =>
      JSON.stringify({
        system: body.system,
        content: body.messages[0]?.content.slice(0, blocks).map(withoutMarker),
      });
    expect(prefix(second, firstEvidence)).toBe(prefix(first, firstEvidence));
    // The previous breakpoint carries no marker now; only the new one does.
    expect(second.messages[0]?.content[firstEvidence - 1]?.cache_control).toBeUndefined();
  });

  it("marks a model whose adapter appends empty system messages after the request", async () => {
    const harness = await twoReviews(managedEffort);
    const [first, second] = harness.reviews.map((review) => wire(AnthropicBody, review));
    if (!first || !second) throw new Error("Missing reviews");
    // Managed effort ends the request with empty `system` messages, not the Reviewed Call.
    expect(first.messages.at(-1)).toMatchObject({ role: "system", content: [] });
    const evidence = (body: AnthropicBody) => (body.messages[0]?.content.length ?? 0) - 1;
    expect(anthropicBreakpoints(first)).toEqual([evidence(first) - 1, evidence(first)]);
    expect(anthropicBreakpoints(second)).toEqual([evidence(second) - 1, evidence(second)]);
    const prefix = (body: AnthropicBody, blocks: number) =>
      JSON.stringify({
        system: body.system,
        content: body.messages[0]?.content.slice(0, blocks).map(withoutMarker),
      });
    expect(prefix(second, evidence(first))).toBe(prefix(first, evidence(first)));
  });

  it("changes nothing else in the request", async () => {
    const harness = await twoReviews(anthropic);
    for (const review of harness.reviews) {
      const body = wire(AnthropicBody, review);
      const [marked] = anthropicBreakpoints(body);
      if (marked === undefined) throw new Error("Missing breakpoint");
      const restored = structuredClone(body);
      delete restored.messages[0]?.content[marked]?.cache_control;
      expect(restored).toEqual(wire(AnthropicBody, review, "built"));
    }
  });

  it("keeps an escalation request on the first pass's prefix", async () => {
    const harness = await createGuardianHarness({
      guardianSettings: { model: anthropic },
      wirePayloads: true,
    });
    harness.responses.push(toolCalls(["deploy", { target: "prod" }, "call-1"]), reply("Ok."));
    harness.guardianReplies.push(...confirmedRejection("high", "low", "Looks risky."));
    await harness.session.prompt("Deploy prod.");
    expect(harness.reviews.map((review) => review.escalation)).toEqual([false, true]);
    const [first, escalation] = harness.reviews.map((review) => wire(AnthropicBody, review));
    if (!first || !escalation) throw new Error("Missing reviews");
    const evidence = (first.messages[0]?.content.length ?? 0) - 1;
    expect(anthropicBreakpoints(first)).toEqual([evidence - 1, evidence]);
    // The escalation marks the same last evidence block, then its own tail: the instruction.
    expect(anthropicBreakpoints(escalation)).toEqual([evidence - 1, evidence + 1]);
    // Everything the first request sent, the Reviewed Call included, leads the escalation's.
    const prefix = (body: AnthropicBody) =>
      JSON.stringify({
        system: body.system,
        content: body.messages[0]?.content.slice(0, evidence + 1).map(withoutMarker),
      });
    expect(prefix(escalation)).toBe(prefix(first));
  });

  it("keeps a corrective retry on the first request's prefix", async () => {
    const harness = await createGuardianHarness({
      guardianSettings: { model: anthropic },
      wirePayloads: true,
    });
    harness.responses.push(toolCalls(["deploy", { target: "prod" }, "call-1"]), reply("Ok."));
    // A `high` risk without a Risk Category is asked about once more.
    harness.guardianReplies.push(
      assessment("high", "high", "Needs a category.", null),
      assessment("high", "high", "Destructive.", "destruction"),
    );
    await harness.session.prompt("Deploy prod.");
    expect(harness.reviews).toHaveLength(2);
    const [first, retry] = harness.reviews.map((review) => wire(AnthropicBody, review));
    if (!first || !retry) throw new Error("Missing reviews");
    const evidence = (first.messages[0]?.content.length ?? 0) - 1;
    expect(anthropicBreakpoints(first)).toEqual([evidence - 1, evidence]);
    // The retry keeps the evidence breakpoint and moves the adapter's tail to its new message.
    expect(anthropicBreakpoints(retry)).toEqual([evidence - 1]);
    expect(retry.messages).toHaveLength(3);
    expect(retry.messages.at(-1)?.content.at(-1)?.cache_control).toBeDefined();
    expect(JSON.stringify(retry.messages[0]?.content.map(withoutMarker))).toBe(
      JSON.stringify(first.messages[0]?.content.map(withoutMarker)),
    );
  });
});

describe("Bedrock evidence cache breakpoint", () => {
  const cachePoints = (body: BedrockBody) =>
    (body.messages[0]?.content ?? []).flatMap((block, at) => (block.cachePoint ? [at] : []));
  const withoutPoints = (body: BedrockBody, blocks: number) =>
    JSON.stringify({
      system: body.system,
      content: body.messages[0]?.content.filter((block) => !block.cachePoint).slice(0, blocks),
    });

  it("places a cache point after the last evidence block", async () => {
    const harness = await twoReviews(bedrock);
    const [first, second] = harness.reviews.map((review) => wire(BedrockBody, review));
    if (!first || !second) throw new Error("Missing reviews");
    const texts = (body: BedrockBody) =>
      (body.messages[0]?.content ?? []).filter((block) => block.text !== undefined).length;
    const firstEvidence = texts(first) - 1;
    const secondEvidence = texts(second) - 1;
    expect(secondEvidence).toBeGreaterThan(firstEvidence);
    // Evidence, its cache point, the Reviewed Call, and the adapter's tail cache point.
    expect(cachePoints(first)).toEqual([firstEvidence, firstEvidence + 2]);
    expect(cachePoints(second)).toEqual([secondEvidence, secondEvidence + 2]);
    expect(JSON.stringify(first.system)).toContain("cachePoint");
    expect(withoutPoints(second, firstEvidence)).toBe(withoutPoints(first, firstEvidence));
  });
});

describe("other APIs", () => {
  it("send the payload their adapter built, unchanged", async () => {
    const harness = await twoReviews("guardian-test/reviewer");
    for (const review of harness.reviews) {
      expect(review.wire?.sent).toBe(review.wire?.built);
      expect(review.wire?.sent).not.toMatch(/cache_control|cachePoint/);
    }
  });
});

describe("evidenceCacheBreakpoint", () => {
  const modelFor = (api: string): Model<Api> => ({ ...anthropicModel, api });
  const anthropicModel: Model<Api> = {
    id: "m",
    name: "m",
    api: "anthropic-messages",
    provider: "p",
    baseUrl: "https://guardian.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1,
    maxTokens: 1,
  };
  const payload = (tail?: { type: string; ttl?: string }) => {
    const call: AnthropicBlock = { type: "text", text: "call" };
    if (tail) call.cache_control = tail;
    return { messages: [{ role: "user", content: [{ type: "text", text: "evidence" }, call] }] };
  };

  it("reuses the tail's cache setting, including its lifetime", async () => {
    const body = payload({ type: "ephemeral", ttl: "1h" });
    await evidenceCacheBreakpoint(1)(body, modelFor("anthropic-messages"));
    expect(body.messages[0]?.content[0]).toEqual({
      type: "text",
      text: "evidence",
      cache_control: { type: "ephemeral", ttl: "1h" },
    });
  });

  it("does nothing where the adapter left caching off", async () => {
    const body = payload();
    const before = structuredClone(body);
    const result = await evidenceCacheBreakpoint(1)(body, modelFor("anthropic-messages"));
    expect(result).toBeUndefined();
    expect(body).toEqual(before);
  });

  it("does nothing without evidence, or when the Reviewed Call would be marked", async () => {
    for (const evidenceBlocks of [0, 2]) {
      const body = payload({ type: "ephemeral" });
      const before = structuredClone(body);
      await evidenceCacheBreakpoint(evidenceBlocks)(body, modelFor("anthropic-messages"));
      expect(body).toEqual(before);
    }
  });

  it("does nothing when the request already holds four breakpoints", async () => {
    const body = payload({ type: "ephemeral" });
    const marked = { type: "text", text: "s", cache_control: { type: "ephemeral" } };
    const full = { ...body, system: [marked, marked], tools: [marked] };
    const before = structuredClone(full);
    expect(await evidenceCacheBreakpoint(1)(full, modelFor("anthropic-messages"))).toBeUndefined();
    expect(full).toEqual(before);
    // One fewer leaves room for it.
    const room = { ...body, system: [marked, marked] };
    expect(await evidenceCacheBreakpoint(1)(room, modelFor("anthropic-messages"))).toBe(room);
    expect(room.messages[0]?.content[0]).toHaveProperty("cache_control");
  });

  it("does nothing to other APIs or a payload shaped otherwise", async () => {
    const hook = evidenceCacheBreakpoint(1);
    for (const api of ["openai-completions", "google-generative-ai", "mistral-conversations"]) {
      const body = payload({ type: "ephemeral" });
      const before = structuredClone(body);
      expect(await hook(body, modelFor(api))).toBeUndefined();
      expect(body).toEqual(before);
    }
    for (const odd of [undefined, null, "text", {}, { messages: "x" }])
      expect(await hook(odd, modelFor("anthropic-messages"))).toBeUndefined();
  });
});

describe("composePayloadHooks", () => {
  // SAFETY: the hooks under test read nothing from the model.
  const model = { api: "anthropic-messages" } as Model<Api>;
  const append =
    (mark: string): PayloadHook =>
    (payload) =>
      Array.isArray(payload) ? [...payload, mark] : undefined;

  it("passes each hook the previous replacement", async () => {
    expect(await composePayloadHooks(append("a"), append("b"))([], model)).toEqual(["a", "b"]);
  });

  it("returns undefined when no hook replaces the payload", async () => {
    const keep: PayloadHook = () => undefined;
    expect(await composePayloadHooks(keep, keep)([], model)).toBeUndefined();
    expect(await composePayloadHooks()([], model)).toBeUndefined();
  });
});
