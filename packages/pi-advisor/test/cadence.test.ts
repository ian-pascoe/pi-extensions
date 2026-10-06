import { onTestFinished, expect, it, vi } from "vitest";
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
import { AdvisorObserver, type AdvisorMode } from "../src/advisor-observer.js";
import { readAdvisorSettings, type AdvisorConfig } from "../src/advisor-settings.js";

/** Short, successful observed tool results unless a test marks some as errors. */
const ok = { result: (id: string) => `ok ${id}`, isError: () => false };

async function observe(
  config: Partial<AdvisorConfig>,
  settings: Parameters<typeof activeFixture>[0] = {},
  extensions: string[] = [],
  mode: AdvisorMode = "headless-root",
) {
  const session = await activeFixture(settings, extensions);
  const observer = new AdvisorObserver(
    session,
    { ...readAdvisorSettings(session).settings, enabled: true, catchUpThreshold: 1, ...config },
    mode,
  );
  // An interactive observer here sees only native agent events, not the settled hook.
  if (mode === "headless-root") globalThis.advisorObserverTest.settled = () => observer.settled();
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

it("reviews a request at native request completion alone, without the settled hook", async () => {
  const privateRequests: PrivateRequest[] = [];
  globalThis.advisorObserverTest = longSessionStream(
    { "Interactive task": 3 },
    privateRequests,
    ok,
  );
  const { session, observer } = await observe({ reviewEvery: "request" }, {}, [], "interactive");
  await session.prompt("Interactive task");
  await vi.waitFor(() => expect(observer.status).toMatchObject({ state: "armed", backlog: 0 }));
  expect(observer.status.lastError).toBeNull();
  expect(privateRequests).toHaveLength(1);
  expect(received(privateRequests[0])).toHaveLength(8);
});

it("waits for Pi's automatic retry before reviewing the request", async () => {
  const privateRequests: PrivateRequest[] = [];
  globalThis.advisorObserverTest = longSessionStream({ "Retried task": 2 }, privateRequests, {
    ...ok,
    firstError: "529 overloaded_error: Overloaded",
  });
  const { session, observer } = await observe(
    { reviewEvery: "request" },
    { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } },
  );
  await session.prompt("Retried task");
  expect(observer.status).toMatchObject({ lastError: null, backlog: 0 });
  // The failed attempt ended a run that Pi retried, so only the retried run's end is reviewed.
  expect(privateRequests).toHaveLength(1);
  const messages = received(privateRequests[0]);
  expect(messages[0]).toBe("user:Retried task");
  expect(messages.at(-1)).toBe("assistant:Done");
});

it("lets a slow whole-request Review finish within the headless final drain", async () => {
  const privateRequests: PrivateRequest[] = [];
  globalThis.advisorObserverTest = longSessionStream({ "Slow review": 4 }, privateRequests, {
    ...ok,
    reviewDelayMs: 40_000,
    report: () => ({
      findings: [
        { severity: "concern", message: "Verify the slow path.", evidence: { quote: "Done" } },
      ],
    }),
  });
  const { session, observer } = await observe({ reviewEvery: "request" });
  onTestFinished(() => {
    vi.useRealTimers();
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let finished = false;
  const prompt = session.prompt("Slow review").then(() => {
    finished = true;
  });
  await vi.waitFor(() => expect(privateRequests).toHaveLength(1));
  // Past the 30-second Catch-up Wait ceiling, the final drain still waits for the Review.
  await vi.advanceTimersByTimeAsync(35_000);
  expect(finished).toBe(false);
  await vi.advanceTimersByTimeAsync(5_000);
  await prompt;
  expect(observer.status).toMatchObject({ lastError: null, backlog: 0 });
  expect(received(privateRequests[0])).toHaveLength(10);
  expect(session.messages.at(-1)).toMatchObject({
    role: "custom",
    customType: "pi-advisor",
    content: "Advisor concern: Verify the slow path.",
  });
});

it("finishes a request's Review across observed compaction after the request, then reseeds", async () => {
  const privateRequests: PrivateRequest[] = [];
  globalThis.advisorObserverTest = longSessionStream(
    { "Big request": 3, "Next request": 1 },
    privateRequests,
    {
      isError: () => false,
      report: (review) => ({
        findings:
          review === 1
            ? [{ severity: "nit", message: "Name the parser helper.", evidence: { quote: "Done" } }]
            : [],
      }),
    },
  );
  const { session, observer } = await observe(
    { reviewEvery: "request" },
    { compaction: { enabled: false, keepRecentTokens: 1_000 } },
    [],
    "interactive",
  );
  await session.prompt("Big request");
  // The observed session compacts while the Review its request's end started is in flight.
  expect(observer.status.state).toBe("reviewing");
  await session.compact();
  await vi.waitFor(() => expect(observer.status.state).toBe("armed"));
  expect(observer.status).toMatchObject({ lastError: null, backlog: 0 });
  // That Review still covers the whole request and delivers its finding.
  expect(privateRequests).toHaveLength(1);
  expect(received(privateRequests[0])).toHaveLength(8);
  expect(
    session.sessionManager
      .getBranch()
      .some((entry) => entry.type === "custom_message" && entry.customType === "pi-advisor"),
  ).toBe(true);
  // The next Review rebuilds the Advisor Session from the compacted observed context.
  await session.prompt("Next request");
  await vi.waitFor(() => expect(privateRequests).toHaveLength(2));
  await vi.waitFor(() => expect(observer.status.state).toBe("armed"));
  expect(observer.status.lastError).toBeNull();
  const next = seedPayload(privateRequests[1]);
  expect(next.header).toContain("Current context seed.");
  expect(JSON.stringify(next.evidence.messages)).toContain(
    "Summary: the user asked to refactor the parser.",
  );
});

it("reseeds within the Context Seed budget when a coarse Review's new evidence would exceed it", async () => {
  const privateRequests: PrivateRequest[] = [];
  globalThis.advisorObserverTest = longSessionStream(
    { "Small request": 1, "Large request": 6 },
    privateRequests,
    { isError: () => false, result: (id) => `result ${id} ${"x".repeat(4_000)}` },
  );
  const { session, observer } = await observe({ reviewEvery: "request", seedBudgetTokens: 4_000 });
  await session.prompt("Small request");
  await session.prompt("Large request");
  expect(observer.status.lastError).toBeNull();
  expect(privateRequests).toHaveLength(2);
  // Six new tool batches exceed the budget, so the Advisor Session is rebuilt from a seed.
  const second = seedPayload(privateRequests[1]);
  expect(second.header).toContain("Current context seed.");
  expect(second.header).toContain("seedBudgetTokens (4000 tokens)");
  expect(second.tokens).toBeLessThanOrEqual(4_000);
  expect(received(privateRequests[1]).at(-1)).toBe("assistant:Done");
  expect(privateRequests[1]?.messages).toHaveLength(1);
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
      evidence: { quote: "Done" },
    };
    const lexer: AdvisorFinding = {
      severity: "concern",
      message: "The lexer change lacks a test.",
      evidence: { quote: "Done" },
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
    expect(third.evidence.deferredFindings.findings).toEqual([lexer]);
    // Prior findings survive: the repeated Concern is not delivered twice.
    const delivered = session.messages.flatMap((message) =>
      message.role === "custom" && message.customType === "pi-advisor" ? [message.content] : [],
    );
    expect(delivered).toEqual(["Advisor concern: The parser change lacks a test."]);
    expectStableAcrossCompaction(privateRequests);
  },
);

/**
 * Advisor cache proof across compaction: every request keeps the system prompt and tools, and
 * each Review without a compaction since the previous one extends its history unchanged.
 * Returns how many consecutive pairs were compared as prefixes and how many spanned compaction.
 */
function expectStableAcrossCompaction(privateRequests: PrivateRequest[]) {
  let prefixes = 0;
  let compactions = 0;
  for (const [index, request] of privateRequests.entries()) {
    const previous = privateRequests[index - 1];
    if (!previous) continue;
    expect(request.systemPrompt).toEqual(previous.systemPrompt);
    expect(request.tools).toEqual(previous.tools);
    if (request.summariesBefore === previous.summariesBefore) {
      expectPrefix(request, previous);
      prefixes++;
    } else compactions++;
  }
  return { prefixes, compactions };
}

it("keeps the Advisor prompt and tools across compaction, and its history a prefix between compactions", async () => {
  const privateRequests: PrivateRequest[] = [];
  const summaries: Context[] = [];
  const requests = Array.from({ length: 12 }, (_, index) => `Request ${index + 1}.`);
  globalThis.advisorObserverTest = longSessionStream(
    Object.fromEntries(requests.map((request) => [request, 1])),
    privateRequests,
    { isError: () => false, summaries },
  );
  const { session, observer } = await observe(
    { reviewEvery: "request", maxSessionTokens: 9_000 },
    { compaction: { enabled: false, keepRecentTokens: 1_000 } },
  );
  for (const request of requests) await session.prompt(request);
  expect(observer.status.lastError).toBeNull();
  expect(privateRequests).toHaveLength(12);
  const { prefixes, compactions } = expectStableAcrossCompaction(privateRequests);
  expect(prefixes).toBeGreaterThanOrEqual(4);
  expect(compactions).toBeGreaterThanOrEqual(2);
  // Every Review after the first stays incremental, across compaction too.
  for (const request of privateRequests.slice(1))
    expect(seedPayload(request).header).toContain("Incremental update.");
});

it.each(["headless-root", "owned-child"] as const)(
  "lets the %s final drain wait for a running Advisor Session compaction",
  async (mode) => {
    const privateRequests: PrivateRequest[] = [];
    const summaries: Context[] = [];
    globalThis.advisorObserverTest = longSessionStream(
      { "Request 1.": 0, "Request 2.": 0, "Request 3.": 0 },
      privateRequests,
      {
        isError: () => false,
        summaries,
        summaryDelayMs: 300,
      },
    );
    // No Catch-up Wait, so only the final drain can wait for the compaction.
    const { session, observer } = await observe(
      { maxSessionTokens: 1_000, catchUpThreshold: "off" },
      { compaction: { enabled: false, keepRecentTokens: 1_000 } },
      [],
      mode,
    );
    // The drain starts once the Review itself has finished, while its compaction still runs.
    const reviewed = () => vi.waitFor(() => expect(observer.status.backlog).toBe(0));
    globalThis.advisorObserverTest.settled = async () => {
      if (mode !== "headless-root") return;
      await reviewed();
      await observer.settled();
    };
    const finish = async (request: string) => {
      await session.prompt(request);
      if (mode !== "owned-child") return;
      await reviewed();
      await observer.finishOwnedTurn();
    };
    // Each request is one turn, reviewed at once; padding makes the second compact.
    await finish("Request 1.");
    await finish(`Request 2. ${"pad ".repeat(1_500)}`);
    expect(summaries).toHaveLength(1);
    await finish("Request 3.");
    expect(observer.status.lastError).toBeNull();
    expect(privateRequests).toHaveLength(3);
    // The drain waited, so the compacted Advisor Session continues rather than being discarded.
    expect(seedPayload(privateRequests[2]).header).toContain("Incremental update.");
    expect(JSON.stringify(privateRequests[2]?.messages)).toContain(
      "Summary: the user asked to refactor the parser.",
    );
  },
);

it("keeps the Advisor Session when Pi declines to compact a session that is all recent history", async () => {
  const privateRequests: PrivateRequest[] = [];
  const summaries: Context[] = [];
  globalThis.advisorObserverTest = longSessionStream(
    { "Request 1.": 1, "Request 2.": 1 },
    privateRequests,
    { isError: () => false, summaries },
  );
  // The first Review's Context Seed alone exceeds the cap, but Pi keeps it as recent history.
  const { session, observer } = await observe(
    { reviewEvery: "request", maxSessionTokens: 1_000 },
    { compaction: { enabled: false, keepRecentTokens: 1_000 } },
  );
  await session.prompt("Request 1.");
  expect(observer.status.lastError).toBeNull();
  expect(seedPayload(privateRequests[0]).tokens).toBeGreaterThan(1_000);
  expect(summaries).toEqual([]);
  await session.prompt("Request 2.");
  expect(observer.status.lastError).toBeNull();
  // Declining is not a failure: the same Advisor Session continues incrementally.
  expect(seedPayload(privateRequests[1]).header).toContain("Incremental update.");
  expectPrefix(privateRequests[1], privateRequests[0]);
});

it.each([
  ["times out", { hangSummaries: true }, {}],
  ["is cancelled by an inherited extension", {}, { cancel: true }],
])(
  "reseeds instead of pausing when Advisor Session compaction %s",
  async (_failure, streamOptions, beforeCompact) => {
    const privateRequests: PrivateRequest[] = [];
    const summaries: Context[] = [];
    const requests = ["Request 1.", "Request 2.", "Request 3."];
    globalThis.advisorObserverTest = longSessionStream(
      Object.fromEntries(requests.map((request) => [request, 1])),
      privateRequests,
      { isError: () => false, summaries, ...streamOptions },
    );
    globalThis.advisorObserverTest.privateBeforeCompact = () =>
      "cancel" in beforeCompact ? { cancel: true } : undefined;
    // Without a headless final drain, only the compaction deadline can end a hung compaction.
    const { session, observer } = await observe(
      { reviewEvery: "request", maxSessionTokens: 4_000, reviewTimeoutMs: 1_000 },
      { compaction: { enabled: false, keepRecentTokens: 1_000 } },
      [],
      "interactive",
    );
    for (const request of requests) {
      await session.prompt(request);
      await vi.waitFor(() => expect(observer.status.state).toBe("armed"), { timeout: 5_000 });
    }
    expect(observer.status.lastError).toBeNull();
    expect(privateRequests).toHaveLength(3);
    // The second Review's compaction failed after its findings were delivered.
    expect(seedPayload(privateRequests[1]).header).toContain("Incremental update.");
    expect(summaries).toHaveLength("cancel" in beforeCompact ? 0 : 1);
    // The next Review starts a fresh Advisor Session from a budgeted Context Seed.
    const third = seedPayload(privateRequests[2]);
    expect(third.header).toContain("Current context seed.");
    expect(privateRequests[2]?.messages).toHaveLength(1);
    expect(observer.status.reviewCost?.reviews).toBe(3);
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

it("reports a Review without usage on a priced model as a known $0", async () => {
  globalThis.advisorObserverTest = longSessionStream({}, [], ok);
  const { session, observer } = await observe({ model: "observer-fixture/priced" });
  await session.prompt("First");
  expect(observer.status.lastError).toBeNull();
  expect(observer.status.reviewCost).toEqual({ reviews: 1, last: 0, total: 0 });
});

it("reports unknown Review cost as unknown, not zero", async () => {
  globalThis.advisorObserverTest = longSessionStream({}, [], ok);
  const { session, observer } = await observe({});
  await session.prompt("First");
  expect(observer.status.reviewCost).toEqual({ reviews: 1, last: null, total: null });
});
