import { onTestFinished, expect, it } from "vite-plus/test";
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
import { readAdvisorSettings, sessionTokenLimit } from "../src/advisor-settings.js";
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

it("fits a later Context Seed to seedBudgetTokens in reported tokens when the model reports 3× Pi's estimate", async () => {
  const ratio = 3;
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
  expect(reported(privateRequests[0], ratio)).toBeGreaterThan(budget * 1.2);
  // The later seed fits the budget in reported tokens, within tolerance, without wasting it.
  expect(reported(privateRequests[1], ratio)).toBeLessThanOrEqual(budget * 1.05);
  expect(reported(privateRequests[1], ratio)).toBeGreaterThan(budget * 0.6);
  // The learned factor is the ratio rounded up to a quarter, with no setup bias: the second
  // seed's estimate is the budget over 2 at 1.8× and over 3 at 3×.
  const factor = Math.ceil(ratio / 0.25) * 0.25;
  expect(second?.tokens).toBeLessThanOrEqual(budget / factor);
  expect(second?.tokens).toBeGreaterThan((budget / factor) * 0.9);
});

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

it("keeps adding incremental evidence that fits the budget in reported tokens", async () => {
  const privateRequests: PrivateRequest[] = [];
  globalThis.advisorObserverTest = longSessionStream(
    { "First request": 2, "Second request": 3 },
    privateRequests,
    { result: (id) => `result ${id} ${"x".repeat(9_500)}`, isError: () => false, tokenRatio: 0.95 },
  );
  const { session, observer } = await observe({ reviewEvery: "request", seedBudgetTokens: 8_000 });
  await session.prompt("First request: refactor the parser.");
  const first = seedPayload(privateRequests[0]);
  // The fallback factor of 2 halves the seed's estimate budget.
  expect(first.tokens).toBeLessThanOrEqual(4_000);
  await session.prompt("Second request: add tests.");
  expect(observer.status.lastError).toBeNull();
  // The model reports slightly under Pi's estimate (0.95×, so the factor floors at 1 despite the
  // JSON framing around each message). The new evidence's estimate lies between the budget over
  // 1.25 and the budget, so it fits only if the factor fell to 1, which a bias from the cached
  // system prompt and tools would prevent (the factor would stay at 1.25 or more).
  const second = seedPayload(privateRequests[1]);
  expect(second.header).toContain("Incremental update.");
  expect(second.tokens).toBeGreaterThan(8_000 / 1.25);
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
  const cap = sessionTokenLimit("auto", wide.contextWindow);

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
