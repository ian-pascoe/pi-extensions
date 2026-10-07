import { describe, expect, it, onTestFinished, vi } from "vitest";
import { textTokens } from "../src/guardian-evidence.js";
import {
  assessment,
  createGuardianHarness,
  reply,
  toolCalls,
  type CapturedReview,
} from "./fixtures/guardian-harness.js";

/** A captured review's evidence blocks: every text block but the final Reviewed Call. */
function evidenceBlocks(review: CapturedReview | undefined): string[] {
  const [message] = review?.messages ?? [];
  if (message?.role !== "user" || !Array.isArray(message.content)) return [];
  return message.content.slice(0, -1).map((part) => (part.type === "text" ? part.text : ""));
}

const blockTokens = (blocks: readonly string[]) =>
  blocks.reduce((sum, block) => sum + textTokens(block), 0);

/** Run `turns` sequential deploys whose long arguments overflow the evidence budget. */
async function overflowingSession(turns: number, promptTokens: (estimated: number) => number) {
  const harness = await createGuardianHarness({
    guardianSettings: { model: "guardian-test/reviewer", evidenceBudgetTokens: 3_000 },
    promptTokens,
  });
  for (let turn = 0; turn < turns; turn++)
    harness.responses.push(
      toolCalls(["deploy", { target: `${turn}:${"x".repeat(300)}` }, `call-${turn}`]),
    );
  harness.responses.push(reply("Done."));
  harness.verdicts.push(
    ...Array.from({ length: turns }, () => assessment("low", "high", "Requested.")),
  );
  await harness.session.prompt("Deploy every target, one at a time.");
  return harness;
}

describe("Guardian prompt-cache stability", () => {
  it("keeps successive reviews on an identical, append-only request prefix", async () => {
    const harness = await createGuardianHarness({
      guardianSettings: { model: "guardian-test/reviewer", policy: "Staging is trusted." },
      contextFiles: (dir) => [
        { path: `${dir}/AGENTS.md`, content: "Deploying to staging is always fine." },
      ],
    });
    harness.responses.push(
      toolCalls(["deploy", { target: "staging" }, "call-1"]),
      toolCalls(["lookup", { query: "status" }, "call-2"]),
      toolCalls(["deploy", { target: "staging-2" }, "call-3"]),
      reply("Done."),
    );
    harness.verdicts.push(
      assessment("low", "high", "Requested."),
      assessment("low", "high", "Requested."),
    );
    await harness.session.prompt("Deploy staging twice, checking status in between.");
    expect(harness.reviews).toHaveLength(2);
    const [first, second] = harness.reviews;
    if (!first || !second) throw new Error("Missing reviews");

    // The system prompt carries only the built-in policy and Security Policy.
    expect(second.systemPrompt).toBe(first.systemPrompt);
    expect(first.systemPrompt).toContain("# Security Policy\nStaging is trusted.\n\n# Output");

    // One user message whose ordered blocks extend the previous request's; only the final
    // Reviewed Call block differs.
    expect(first.messages).toHaveLength(1);
    expect(second.messages).toHaveLength(1);
    const content = (review: typeof first) => {
      const [message] = review.messages;
      if (message?.role !== "user" || !Array.isArray(message.content))
        throw new Error("Expected one user message with content blocks");
      return { timestamp: message.timestamp, blocks: message.content };
    };
    const earlier = content(first);
    const later = content(second);
    expect(later.timestamp).toBe(earlier.timestamp);
    const prefix = earlier.blocks.slice(0, -1);
    expect(later.blocks.slice(0, prefix.length)).toEqual(prefix);
    expect(later.blocks.length).toBeGreaterThan(earlier.blocks.length);
    // Project instructions open the evidence as Trusted Evidence.
    expect(prefix[0]).toEqual({
      type: "text",
      text: expect.stringMatching(
        /^Evidence \(TRUSTED, origin: projectInstructions\):\n.*Deploying to staging is always fine/s,
      ),
    });
    expect(prefix[1]).toEqual({
      type: "text",
      text: expect.stringMatching(/^Evidence \(TRUSTED, origin: user\):/),
    });
    expect(later.blocks.at(-1)).toEqual({
      type: "text",
      text: expect.stringContaining('Arguments: {"target":"staging-2"}'),
    });
  });
});

describe("evidence that overflows its budget", () => {
  it("keeps successive requests on a shared prefix, re-anchoring rarely", async () => {
    // The provider reports 1.5× Pi's estimate, matching the uncalibrated factor.
    const turns = 32;
    const harness = await overflowingSession(turns, (estimated) => Math.ceil(estimated * 1.5));
    expect(harness.reviews).toHaveLength(turns);
    const rawBudget = Math.floor(3_000 / 1.5);
    const evidence = harness.reviews.map(evidenceBlocks);
    // One turn: an assistant tool call and its result.
    const perTurn = blockTokens(evidence.at(-1)?.slice(-3, -1) ?? []);
    const reanchors: number[] = [];
    let growth = 0;
    const growthAtReanchor: number[] = [];
    for (const [index, blocks] of evidence.entries()) {
      expect(blockTokens(blocks)).toBeLessThanOrEqual(rawBudget);
      // The user's request is always the first block, unchanged.
      expect(blocks[0]).toBe(evidence[0]?.[0]);
      if (index === 0) continue;
      const previous = evidence[index - 1] ?? [];
      const extends_ = previous.every((block, at) => blocks[at] === block);
      if (extends_) growth += blockTokens(blocks.slice(previous.length));
      else {
        reanchors.push(index);
        // The re-anchoring review's own turn is history growth too.
        growthAtReanchor.push(growth + perTurn);
        growth = 0;
      }
    }
    console.info(
      `overflow: ${turns} reviews, raw budget ${rawBudget}, re-anchors at ${reanchors.join(", ")}, growth between re-anchors ${growthAtReanchor.join(", ")} tokens`,
    );
    // The history overflowed, yet most requests extend the previous one.
    expect(reanchors.length).toBeGreaterThanOrEqual(2);
    expect(reanchors.length).toBeLessThanOrEqual(turns / 4);
    // After the first, each re-anchor follows roughly half a budget of growth.
    for (const between of growthAtReanchor.slice(1))
      expect(between).toBeGreaterThanOrEqual(rawBudget / 2 - perTurn);
  });

  it("calibrates the token estimate from the provider's reported prompt tokens", async () => {
    // The provider reports 2.5× Pi's chars/4 estimate.
    // At the uncalibrated 1.5×, evidence grows to nearly 3,000 / 1.5 estimated tokens.
    const uncalibrated = await overflowingSession(16, (estimated) => Math.ceil(estimated * 1.5));
    const largest = Math.max(...uncalibrated.reviews.map(evidenceBlocks).map(blockTokens));
    expect(largest).toBeLessThanOrEqual(2_000);
    expect(largest).toBeGreaterThan(1_200);
    // Every later review shrinks to 3,000 / 2.5 once the provider reports 2.5× the estimate.
    const harness = await overflowingSession(16, (estimated) => Math.ceil(estimated * 2.5));
    const later = harness.reviews.slice(1).map(evidenceBlocks).map(blockTokens);
    for (const tokens of later) {
      expect(tokens).toBeLessThanOrEqual(1_200);
      // In the provider's real tokens, evidence stays within its 3,000-token budget.
      expect(Math.ceil(tokens * 2.5)).toBeLessThanOrEqual(3_000);
    }
    console.info(
      `calibration: largest evidence ${largest} est. tokens at 1.5x; at 2.5x at most ${Math.max(...later)} (real ${Math.ceil(Math.max(...later) * 2.5)} of 3000)`,
    );
  });
});

describe("calibration from the session", () => {
  it("records calibration samples, so a reloaded session keeps its factor", async () => {
    const scale = (estimated: number) => Math.ceil(estimated * 2.5);
    const first = await overflowingSession(16, scale);
    expect(first.entries("pi-guardian-review")).toContainEqual(
      expect.objectContaining({
        estimatedPromptTokens: expect.any(Number),
        promptTokens: expect.any(Number),
      }),
    );
    const reloaded = await createGuardianHarness({
      guardianSettings: { model: "guardian-test/reviewer", evidenceBudgetTokens: 3_000 },
      manager: first.manager,
      promptTokens: scale,
    });
    reloaded.responses.push(
      toolCalls(["deploy", { target: `again:${"x".repeat(300)}` }, "call-again"]),
      reply("Done."),
    );
    reloaded.verdicts.push(assessment("low", "high", "Requested."));
    await reloaded.session.prompt("Deploy once more.");
    // Its first review already uses the 2.5\u00d7 factor the session recorded, not the 1.5\u00d7 fallback.
    const tokens = blockTokens(evidenceBlocks(reloaded.reviews[0]));
    expect(tokens).toBeLessThanOrEqual(1_200);
    expect(tokens).toBeGreaterThan(600);
  });
});

describe("the Guarded Agent's requests", () => {
  /** Run one scripted conversation and return the agent's serialized requests. */
  async function conversation(options: Parameters<typeof createGuardianHarness>[0]) {
    // Freeze clocks only: timestamps and nested-call durations are recorded in the transcript.
    vi.useFakeTimers({ toFake: ["Date", "performance"], now: 1_700_000_000_000 });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const harness = await createGuardianHarness(options);
    harness.responses.push(
      toolCalls(["deploy", { target: "staging" }, "call-1"], ["lookup", { query: "q" }, "call-2"]),
      toolCalls(["script", { targets: ["a"] }, "call-3"]),
      reply("Done."),
    );
    harness.verdicts.push(...Array.from({ length: 3 }, () => assessment("low", "high", "Ok.")));
    await harness.session.prompt("Deploy staging, then run the script.");
    vi.useRealTimers();
    // Each harness has its own temporary workspace; nothing else may differ.
    return harness.agentContexts.map((request) => request.replaceAll(harness.dir, "<workspace>"));
  }

  it("are byte-identical with Guardian enabled, disabled, or not installed", async () => {
    const without = await conversation({ withoutGuardian: true });
    const disabled = await conversation({ guardianSettings: { enabled: false } });
    const enabled = await conversation({ guardianSettings: { model: "guardian-test/reviewer" } });
    expect(without).toHaveLength(3);
    // The serialized transcript includes the system prompt and the ordered tool declarations.
    expect(without[0]).toContain("Deploy the given target.");
    expect(disabled).toEqual(without);
    expect(enabled).toEqual(without);
  });
});
