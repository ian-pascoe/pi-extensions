import { onTestFinished, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import type { Context } from "@earendil-works/pi-ai";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import {
  activeFixture,
  conversation,
  expectPrefix,
  longSessionStream,
  seedPayload,
  type PrivateRequest,
} from "./fixtures/observer-harness.js";
import type { AdvisorFinding } from "../src/advisor-contract.js";
import { AdvisorObserver } from "../src/advisor-observer.js";
import { readAdvisorSettings, type AdvisorConfig } from "../src/advisor-settings.js";

/** Short, successful observed tool results unless a test marks some as errors. */
const ok = { result: (id: string) => `ok ${id}`, isError: () => false };

async function observe(
  config: Partial<AdvisorConfig>,
  settings: Parameters<typeof activeFixture>[0] = {},
  extensions: string[] = [],
) {
  const session = await activeFixture(settings, extensions);
  const observer = new AdvisorObserver(
    session,
    { ...readAdvisorSettings(session).settings, enabled: true, catchUpThreshold: 1, ...config },
    "headless-root",
  );
  globalThis.advisorObserverTest.settled = () => observer.settled();
  onTestFinished(() => observer.dispose());
  return { session, observer };
}

/** Observed messages a Review received, as role/text pairs for compact comparison. */
function received(request: PrivateRequest | undefined): string[] {
  return seedPayload(request).evidence.messages.map(
    (message: { role: string; content: { type: string; text?: string; name?: string }[] }) =>
      `${message.role}:${message.content.map((block) => block.text ?? block.name).join("")}`,
  );
}

it('reviews a multi-turn request once, at its completion, under reviewEvery "request"', async () => {
  const privateRequests: PrivateRequest[] = [];
  globalThis.advisorObserverTest = longSessionStream(
    { "First request": 5, "Second request": 3 },
    privateRequests,
    ok,
  );
  const { session, observer } = await observe({ reviewEvery: "request" });
  await session.prompt("First request: refactor the parser.");
  expect(observer.status).toMatchObject({ lastError: null, backlog: 0 });
  // One Review covers all six turns: the request, five tool batches, and the final answer.
  expect(privateRequests).toHaveLength(1);
  const first = received(privateRequests[0]);
  expect(first).toHaveLength(12);
  expect(first[0]).toBe("user:First request: refactor the parser.");
  expect(first.at(-1)).toBe("assistant:Done");
  expect(first.filter((message) => message.startsWith("toolResult:"))).toHaveLength(5);

  await session.prompt("Second request: add tests.");
  expect(observer.status).toMatchObject({ lastError: null, backlog: 0 });
  expect(privateRequests).toHaveLength(2);
  expect(seedPayload(privateRequests[1]).header).toContain("Incremental update.");
  const second = received(privateRequests[1]);
  expect(second).toHaveLength(8);
  expect(second[0]).toBe("user:Second request: add tests.");
  expectPrefix(privateRequests[1], privateRequests[0]);
});

it.each(["request", 4] as const)(
  "reviews a tool-error turn at once, then the rest of the request, under reviewEvery %s",
  async (reviewEvery) => {
    const privateRequests: PrivateRequest[] = [];
    // The second tool batch (`0-1`) fails; batches are named `<request index>-<batch>`.
    globalThis.advisorObserverTest = longSessionStream({ "Fix the build": 5 }, privateRequests, {
      ...ok,
      isError: (id) => id === "0-1",
    });
    const { session, observer } = await observe({ reviewEvery });
    await session.prompt("Fix the build");
    expect(observer.status).toMatchObject({ lastError: null, backlog: 0 });
    expect(privateRequests).toHaveLength(2);
    // The first Review stops at the failed batch: the request and two tool batches.
    const [failed, rest] = privateRequests.map(received);
    expect(failed).toHaveLength(5);
    expect(failed?.at(-1)).toBe("toolResult:ok 0-1");
    // The second covers every remaining turn: three more batches and the final answer.
    expect(rest).toHaveLength(7);
    expect(rest?.at(-1)).toBe("assistant:Done");
    expect([...(failed ?? []), ...(rest ?? [])]).toHaveLength(
      conversation(session.messages).length,
    );
  },
);

it("reviews every N turns and the remainder at request completion", async () => {
  const privateRequests: PrivateRequest[] = [];
  globalThis.advisorObserverTest = longSessionStream({ "Long task": 7 }, privateRequests, ok);
  const { session, observer } = await observe({ reviewEvery: 3 });
  await session.prompt("Long task");
  expect(observer.status).toMatchObject({ lastError: null, backlog: 0 });
  // Eight turns: Reviews after turns 3 and 6, then turns 7–8 when the request completes.
  expect(privateRequests.map((request) => received(request).length)).toEqual([7, 6, 3]);
  expect(received(privateRequests[2]).at(-1)).toBe("assistant:Done");
});

/** Pi's estimate of an Advisor context, without the newest prompt that started the request. */
function sessionTokens(request: PrivateRequest | undefined): number {
  return (request?.messages ?? [])
    .slice(0, -1)
    .reduce((sum, message) => sum + estimateTokens(message), 0);
}

it.each([
  ["reported context usage", true],
  ["estimated size without usage", false],
])(
  "compacts the Advisor Session natively to stay under maxSessionTokens with %s, keeping its bookkeeping",
  async (_usage, reportContextTokens) => {
    const privateRequests: PrivateRequest[] = [];
    const summaries: Context[] = [];
    const parser: AdvisorFinding = {
      severity: "concern",
      message: "The parser change lacks a test.",
    };
    const lexer: AdvisorFinding = {
      severity: "concern",
      message: "The lexer change lacks a test.",
    };
    // The second Review's Concern falls within the three-turn cooldown, so it is deferred; the
    // third blindly repeats the delivered one, which stays suppressed.
    const concerns = new Map([
      [1, [parser]],
      [2, [lexer]],
      [3, [parser]],
    ]);
    const requests = Array.from({ length: 12 }, (_, index) => `Request ${index + 1}.`);
    globalThis.advisorObserverTest = longSessionStream(
      Object.fromEntries(requests.map((request) => [request, 1])),
      privateRequests,
      {
        result: (id) => `result ${id} ${"x".repeat(8_000)}`,
        isError: () => false,
        reportContextTokens,
        summaries,
        report: (review) => ({ findings: concerns.get(review) ?? [] }),
      },
    );
    const { session, observer } = await observe(
      { reviewEvery: "request", maxSessionTokens: 4_000 },
      { compaction: { enabled: false, keepRecentTokens: 1_000 } },
    );
    for (const request of requests) await session.prompt(request);
    expect(observer.status.lastError).toBeNull();
    expect(privateRequests).toHaveLength(12);

    // Native compaction ran through Pi's summarizer, and each later Review starts under the cap.
    expect(summaries.length).toBeGreaterThanOrEqual(3);
    expect(Math.max(...privateRequests.slice(1).map(sessionTokens))).toBeLessThanOrEqual(4_000);
    expect(sessionTokens(privateRequests.at(-1))).toBeLessThan(4_000);
    const summary = "Summary: the user asked to refactor the parser.";
    expect(JSON.stringify(privateRequests.at(-1)?.messages)).toContain(summary);

    // The first compaction followed the second Review; the third still continues incrementally.
    expect(JSON.stringify(privateRequests[1]?.messages)).not.toContain(summary);
    expect(JSON.stringify(privateRequests[2]?.messages)).toContain(summary);
    const third = seedPayload(privateRequests[2]);
    expect(third.header).toContain("Incremental update.");
    const thirdMessages = received(privateRequests[2]);
    expect(thirdMessages).toHaveLength(4);
    expect(thirdMessages[0]).toBe("user:Request 3.");
    expect(thirdMessages.at(-1)).toBe("assistant:Done");
    // The deferred Concern survives compaction and is re-evaluated.
    expect(third.evidence.deferredConcerns.findings).toEqual([lexer]);
    // Prior findings survive: the repeated Concern is not delivered twice.
    const delivered = session.messages.flatMap((message) =>
      message.role === "custom" && message.customType === "pi-advisor" ? [message.content] : [],
    );
    expect(delivered).toEqual(["Advisor concern: The parser change lacks a test."]);
  },
);

it("leaves a Context Management Advisor Session to its own Rollover instead of compacting it", async () => {
  const privateRequests: PrivateRequest[] = [];
  const summaries: Context[] = [];
  const requests = ["Request 1.", "Request 2.", "Request 3."];
  globalThis.advisorObserverTest = longSessionStream(
    Object.fromEntries(requests.map((request) => [request, 1])),
    privateRequests,
    { isError: () => false, summaries },
  );
  const { session, observer } = await observe(
    {
      reviewEvery: "request",
      maxSessionTokens: 1_000,
      allowedTools: ["read", "context_notes", "context_history", "context_rollover"],
    },
    { compaction: { enabled: false, keepRecentTokens: 500 } },
    [fileURLToPath(new URL("../../pi-context-management/src/index.ts", import.meta.url))],
  );
  for (const request of requests) await session.prompt(request);
  expect(observer.status.lastError).toBeNull();
  expect(privateRequests).toHaveLength(3);
  expect(privateRequests.map((request) => request.text.split("\n", 1)[0])).toEqual([
    expect.stringContaining("Current context seed."),
    expect.stringContaining("Incremental update."),
    expect.stringContaining("Incremental update."),
  ]);
  expect(summaries).toEqual([]);
  expectPrefix(privateRequests[2], privateRequests[1]);
});

it("keeps the private Advisor history a stable prefix between Reviews without compaction", async () => {
  const privateRequests: PrivateRequest[] = [];
  globalThis.advisorObserverTest = longSessionStream(
    { "Step one": 2, "Step two": 2, "Step three": 2 },
    privateRequests,
    ok,
  );
  const { session, observer } = await observe({});
  for (const prompt of ["Step one", "Step two", "Step three"]) await session.prompt(prompt);
  expect(observer.status.lastError).toBeNull();
  // The default cadence still reviews every turn.
  expect(privateRequests).toHaveLength(9);
  for (const [index, request] of privateRequests.entries()) {
    if (index === 0) continue;
    const previous = privateRequests[index - 1];
    expect(request.systemPrompt).toEqual(previous?.systemPrompt);
    expect(request.tools).toEqual(previous?.tools);
    expectPrefix(request, previous);
  }
});

it("reports the last Review's cost and the running total in status", async () => {
  const privateRequests: PrivateRequest[] = [];
  const cost = { input: 0.003, output: 0.001, cacheRead: 0.0005, cacheWrite: 0, total: 0.0045 };
  globalThis.advisorObserverTest = longSessionStream({}, privateRequests, {
    ...ok,
    usage: {
      input: 1_000,
      output: 100,
      cacheRead: 500,
      cacheWrite: 0,
      totalTokens: 1_600,
      cost,
    },
  });
  const { session, observer } = await observe({});
  expect(observer.status.reviewCost).toBeNull();
  await session.prompt("First");
  expect(observer.status.reviewCost).toEqual({ reviews: 1, last: 0.0045, total: 0.0045 });
  await session.prompt("Second");
  expect(observer.status.lastError).toBeNull();
  expect(observer.status.reviewCost).toMatchObject({ reviews: 2, last: 0.0045 });
  expect(observer.status.reviewCost?.total).toBeCloseTo(0.009);
});

it("reports unknown Review cost as unknown, not zero", async () => {
  globalThis.advisorObserverTest = longSessionStream({}, [], ok);
  const { session, observer } = await observe({});
  await session.prompt("First");
  expect(observer.status.reviewCost).toEqual({ reviews: 1, last: null, total: null });
});
