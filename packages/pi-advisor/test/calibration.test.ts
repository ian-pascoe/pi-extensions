import { onTestFinished, expect, it } from "vitest";
import type { Context } from "@earendil-works/pi-ai";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import {
  activeFixture,
  expectPrefix,
  longSessionStream,
  seedPayload,
  type PrivateRequest,
} from "./fixtures/observer-harness.js";
import { AdvisorObserver } from "../src/advisor-observer.js";
import { readAdvisorSettings, seedBudget, sessionTokenLimit } from "../src/advisor-settings.js";
import type { AdvisorConfig } from "../src/advisor-settings.js";

async function observe(config: Partial<AdvisorConfig>) {
  const session = await activeFixture();
  const observer = new AdvisorObserver(
    session,
    {
      ...readAdvisorSettings(session).settings,
      enabled: true,
      catchUpThreshold: 1,
      // These tests size evidence by token budgets, so they leave tool results uncapped.
      maxToolResultChars: 1_000_000,
      ...config,
    },
    "headless-root",
  );
  globalThis.advisorObserverTest.settled = () => observer.settled();
  onTestFinished(() => observer.dispose());
  return { session, observer };
}

const bulky = (id: string) => `result ${id} ${"x".repeat(8_000)}`;

/** What the provider reports for a seed's JSON: its chars/4 estimate times the model's ratio. */
const reported = (request: PrivateRequest | undefined, ratio: number) =>
  seedPayload(request).tokens * ratio;

it.each([1.8, 3])(
  "fits a later Context Seed to seedBudgetTokens in reported tokens when the model reports %s× Pi's estimate",
  async (ratio) => {
    const budget = 12_000;
    const privateRequests: PrivateRequest[] = [];
    globalThis.advisorObserverTest = longSessionStream(
      { "Original request": 40, "Second request": 40 },
      privateRequests,
      { result: bulky, isError: () => false, tokenRatio: ratio },
    );
    const { session, observer } = await observe({
      reviewEvery: "request",
      seedBudgetTokens: budget,
    });
    await session.prompt("Original request: refactor the parser.");
    // Forty large tool results gathered in one request exceed the budget, so the next Review
    // rebuilds the Advisor Session from a new Context Seed, now calibrated to the model.
    await session.prompt("Second request: add tests.");
    expect(observer.status.lastError).toBeNull();
    expect(privateRequests).toHaveLength(2);
    const [first, second] = privateRequests.map(seedPayload);
    expect(first?.header).toContain("Current context seed.");
    expect(second?.header).toContain("Current context seed.");
    expect(second?.header).toContain(`seedBudgetTokens (${budget} tokens)`);

    // Before any sample, the conservative fallback sizes the seed; a denser model overshoots it.
    if (ratio > 2) expect(reported(privateRequests[0], ratio)).toBeGreaterThan(budget * 1.2);
    // The later seed fits the budget in reported tokens, within tolerance, without wasting it.
    expect(reported(privateRequests[1], ratio)).toBeLessThanOrEqual(budget * 1.05);
    expect(reported(privateRequests[1], ratio)).toBeGreaterThan(budget * 0.6);
  },
);

it("keeps its factor, and so the Advisor context prefix, steady while the ratio is stable", async () => {
  const privateRequests: PrivateRequest[] = [];
  globalThis.advisorObserverTest = longSessionStream(
    { "Original request": 40, "Second request": 40 },
    privateRequests,
    { result: bulky, isError: () => false, tokenRatio: 1.8 },
  );
  const { session } = await observe({ reviewEvery: "request", seedBudgetTokens: 12_000 });
  await session.prompt("Original request: refactor the parser.");
  await session.prompt("Second request: add tests.");
  await session.prompt("Third request.");
  // Same ratio, same factor: the re-seed keeps the first seed's size, and the later update extends it.
  const sizes = privateRequests.slice(0, 2).map((request) => seedPayload(request).tokens);
  expect(Math.abs((sizes[1] ?? 0) - (sizes[0] ?? 0))).toBeLessThan(50);
  expect(seedPayload(privateRequests[2]).header).toContain("Incremental update.");
  expectPrefix(privateRequests[2], privateRequests[1]);
});

it("keeps an auto seed and its first Review under the auto maxSessionTokens", async () => {
  const ratio = 2;
  const privateRequests: PrivateRequest[] = [];
  const summaries: Context[] = [];
  globalThis.advisorObserverTest = longSessionStream({ "Original request": 60 }, privateRequests, {
    result: bulky,
    isError: () => false,
    tokenRatio: ratio,
    summaries,
  });
  const { session, observer } = await observe({
    reviewEvery: "request",
    seedBudgetTokens: "auto",
    maxSessionTokens: "auto",
  });
  await session.prompt("Original request: refactor the parser.");
  expect(observer.status.lastError).toBeNull();
  // The fixture model's 200k window gives a 50k seed budget and a 100k session cap.
  const window = session.model?.contextWindow;
  const budget = seedBudget("auto", window);
  const cap = sessionTokenLimit("auto", window);
  expect(seedPayload(privateRequests[0]).header).toContain(`seedBudgetTokens (${budget} tokens)`);
  // The seed filled most of its budget, measured in reported tokens.
  expect(reported(privateRequests[0], ratio)).toBeGreaterThan(budget * 0.6);
  expect(reported(privateRequests[0], ratio)).toBeLessThanOrEqual(budget);
  // With the seed in reported tokens, the Advisor Session plus its first Review stays under the
  // cap, so nothing compacts it. Pi's estimate alone put the seed at the cap before the Review.
  expect(reported(privateRequests[0], ratio)).toBeLessThan(cap);
  expect(summaries).toHaveLength(0);
});

it("keeps adding incremental evidence that fits the budget in reported tokens", async () => {
  const privateRequests: PrivateRequest[] = [];
  globalThis.advisorObserverTest = longSessionStream(
    { "First request": 2, "Second request": 2 },
    privateRequests,
    { result: bulky, isError: () => false, tokenRatio: 1 },
  );
  const { session, observer } = await observe({ reviewEvery: "request", seedBudgetTokens: 8_000 });
  await session.prompt("First request: refactor the parser.");
  const first = seedPayload(privateRequests[0]);
  // The fallback factor of 2 halves the seed's estimate budget.
  expect(first.tokens).toBeLessThanOrEqual(4_000);
  await session.prompt("Second request: add tests.");
  expect(observer.status.lastError).toBeNull();
  // The model reported about 1× Pi's estimate, so about 5k estimated tokens of new evidence
  // fit 8k reported tokens, though they would not at the fallback factor.
  const second = seedPayload(privateRequests[1]);
  expect(second.header).toContain("Incremental update.");
  expect(second.tokens).toBeGreaterThan(4_000);
  expect(second.tokens).toBeLessThanOrEqual(8_000);
  expectPrefix(privateRequests[1], privateRequests[0]);
});

it("keeps a long session's Advisor Session under the auto cap on a 1M-token window", async () => {
  const ratio = 2;
  const privateRequests: PrivateRequest[] = [];
  const summaries: Context[] = [];
  const requests = Array.from({ length: 30 }, (_, index) => `Request ${index + 1}.`);
  globalThis.advisorObserverTest = longSessionStream(
    Object.fromEntries(requests.map((request) => [request, 2])),
    privateRequests,
    {
      result: (id) => `result ${id} ${"x".repeat(16_000)}`,
      isError: () => false,
      tokenRatio: ratio,
      summaries,
    },
  );
  const { session, observer } = await observe({
    reviewEvery: "request",
    seedBudgetTokens: "auto",
    maxSessionTokens: "auto",
  });
  const wide = session.modelRuntime.getModel("observer-fixture", "wide");
  if (!wide) throw new Error("Missing wide fixture model");
  await session.setModel(wide);
  // The window's own fractions would allow 250k and 500k; the ceilings hold 50k and 100k.
  expect(seedBudget("auto", wide.contextWindow)).toBe(50_000);
  const cap = sessionTokenLimit("auto", wide.contextWindow);
  expect(cap).toBe(100_000);

  for (const request of requests) await session.prompt(request);
  expect(observer.status.lastError).toBeNull();
  expect(privateRequests).toHaveLength(requests.length);

  // The Advisor Session's reported size before each Review's prompt: the cached system prompt and
  // tools at Pi's estimate, the history at the model's ratio to Pi's estimate.
  const size = (request: PrivateRequest | undefined) =>
    Math.ceil(JSON.stringify([request?.systemPrompt, request?.tools]).length / 4) +
    Math.ceil(
      (request?.messages ?? [])
        .slice(0, -1)
        .reduce((sum, message) => sum + estimateTokens(message), 0) * ratio,
    );
  const sizes = privateRequests.map(size);
  // Without compaction the session would pass 200k; instead it compacts and stays under the cap.
  expect(summaries.length).toBeGreaterThan(0);
  expect(Math.max(...sizes)).toBeLessThanOrEqual(cap);
  // The cap, not an earlier trigger, bounds it: it grows well past the seed budget first.
  expect(Math.max(...sizes)).toBeGreaterThan(cap * 0.6);
});
