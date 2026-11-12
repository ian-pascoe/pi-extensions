import { readFileSync } from "node:fs";
import { onTestFinished, expect, it } from "vite-plus/test";
import {
  activeFixture,
  expectPrefix,
  longSessionStream,
  seedPayload,
  type PrivateRequest,
} from "./fixtures/observer-harness.js";
import { AdvisorObserver } from "../src/advisor-observer.js";
import { readAdvisorSettings, type AdvisorConfig } from "../src/advisor-settings.js";

/** A result whose head, middle, and tail are distinguishable. */
const big = (id: string, size = 30_000) =>
  `HEAD ${id} ${"a".repeat(size / 2)} MIDDLE ${"b".repeat(size / 2)} TAIL ${id}`;

async function observe(config: Partial<AdvisorConfig>) {
  const session = await activeFixture();
  const observer = new AdvisorObserver(
    session,
    { ...readAdvisorSettings(session).settings, enabled: true, catchUpThreshold: 1, ...config },
    "headless-root",
  );
  globalThis.advisorObserverTest.settled = () => observer.settled();
  onTestFinished(() => observer.dispose());
  return { session, observer };
}

type Block = { type: string; text?: string; ref?: string };
type ResultMessage = {
  role: string;
  ref?: string;
  isError?: boolean;
  content: Block[];
};
const results = (messages: ResultMessage[]) => messages.filter((m) => m.role === "toolResult");
const refs = (messages: ResultMessage[]) =>
  messages
    .filter((m) => m.role === "assistant")
    .flatMap((m) => m.content.flatMap((block) => (block.ref ? [block.ref] : [])));

it("caps an oversized tool result in a seed and an incremental update, keeping its Tool-Call Reference", async () => {
  const privateRequests: PrivateRequest[] = [];
  globalThis.advisorObserverTest = longSessionStream(
    { "First request": 1, "Second request": 1 },
    privateRequests,
    { result: (id) => big(id), isError: () => false },
  );
  const { session, observer } = await observe({ reviewEvery: "request" });
  const longPrompt = `First request: ${"u".repeat(12_000)}`;
  await session.prompt(longPrompt);
  await session.prompt("Second request: add tests.");
  expect(observer.status.lastError).toBeNull();
  const file = session.sessionManager.getSessionFile();
  expect(file).toBeTruthy();
  const stored = readFileSync(file ?? "", "utf8");

  const seed = seedPayload(privateRequests[0]);
  const update = seedPayload(privateRequests[1]);
  expect(seed.header).toContain("Current context seed.");
  expect(update.header).toContain("Incremental update.");
  for (const { evidence } of [seed, update]) {
    const messages: ResultMessage[] = evidence.messages;
    const [result] = results(messages);
    expect(result).toBeDefined();
    const text = result?.content[0]?.text ?? "";
    // Head and tail survive; the marker names the omission and where the full result is.
    expect(text).toMatch(/^HEAD \d+-\d+ a+/);
    expect(text).toMatch(/b+ TAIL \d+-\d+$/);
    expect(text).not.toContain("MIDDLE");
    expect(text).toMatch(
      new RegExp(
        `\\n\\[… \\d+ characters omitted from this tool result; the full result is in the observed session file ${file}\\]\\n`,
      ),
    );
    expect(text.length).toBeLessThan(4_000 + 400);
    // The reference still links the call to its result, and the error status is kept.
    expect(result?.isError).toBe(false);
    expect(refs(messages)).toContain(result?.ref);
    // The full result is where the marker points.
    expect(stored).toContain("MIDDLE");
  }
  // User text is never capped.
  expect(JSON.stringify(seed.evidence.messages)).toContain(longPrompt);
  expectPrefix(privateRequests[1], privateRequests[0]);
});

it("honors maxToolResultChars", async () => {
  const privateRequests: PrivateRequest[] = [];
  globalThis.advisorObserverTest = longSessionStream({ Request: 1 }, privateRequests, {
    result: (id) => big(id, 3_000),
    isError: () => false,
  });
  const { session } = await observe({ reviewEvery: "request", maxToolResultChars: 1_000 });
  await session.prompt("Request: refactor.");
  const [result] = results(seedPayload(privateRequests[0]).evidence.messages);
  expect(result?.content[0]?.text).toContain("characters omitted from this tool result");
  expect(result?.content[0]?.text?.length).toBeLessThan(1_000 + 400);
});

it("measures whether new evidence fits the seed budget on the capped evidence", async () => {
  const privateRequests: PrivateRequest[] = [];
  globalThis.advisorObserverTest = longSessionStream(
    { "First request": 1, "Second request": 4 },
    privateRequests,
    { result: (id) => big(id, 120_000), isError: () => false, tokenRatio: 1 },
  );
  // Four 120k-character results are about 120k estimated tokens uncapped, far over this budget,
  // but about 5k tokens once capped, which fits.
  const { session, observer } = await observe({
    reviewEvery: "request",
    seedBudgetTokens: 12_000,
  });
  await session.prompt("First request: refactor.");
  await session.prompt("Second request: add tests.");
  expect(observer.status.lastError).toBeNull();
  const update = seedPayload(privateRequests[1]);
  expect(update.header).toContain("Incremental update.");
  expect(update.tokens).toBeLessThan(6_000);
  expect(results(update.evidence.messages)).toHaveLength(4);
  expectPrefix(privateRequests[1], privateRequests[0]);
});

it("spends the seed budget on capped evidence", async () => {
  const privateRequests: PrivateRequest[] = [];
  globalThis.advisorObserverTest = longSessionStream({ Request: 40 }, privateRequests, {
    result: (id) => big(id, 20_000),
    isError: () => false,
  });
  const { session } = await observe({ reviewEvery: "request", seedBudgetTokens: 24_000 });
  await session.prompt("Request: refactor.");
  const seed = seedPayload(privateRequests[0]);
  // Uncapped, forty 20k-character results are ~200k tokens; capped, most turns fit 12k estimated.
  expect(seed.tokens).toBeLessThanOrEqual(12_000);
  const kept = results(seed.evidence.messages);
  expect(kept.length).toBeGreaterThan(8);
  // The fit may shorten the oldest kept turn to spend the remaining budget, which replaces its cap
  // marker with the Context Seed's. Where that cut falls depends on the session-file path inside
  // each cap marker, so only the oldest result may carry either marker.
  const [oldest, ...newer] = kept;
  expect(oldest?.content[0]?.text).toMatch(/omitted from (?:this tool result|the Context Seed)/);
  for (const result of newer) expect(result.content[0]?.text).toContain("this tool result");
});
