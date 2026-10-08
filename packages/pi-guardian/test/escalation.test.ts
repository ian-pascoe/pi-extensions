import { stripVTControlCharacters } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { renderReviewEntry } from "../src/guardian-rendering.js";
import type { GuardianOptions } from "../src/guardian-settings.js";
import {
  assessment,
  createGuardianHarness,
  DeferredReply,
  reply,
  toolCalls,
  type CapturedReview,
} from "./fixtures/guardian-harness.js";

beforeAll(() => initTheme("dark"));

const reviewer = { model: "guardian-test/reviewer", thinkingLevel: "off" } as const;
const plainTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_c: string, t: string) => t,
  bold: (text: string) => text,
};

/** The text blocks of a captured Guardian request's single user message. */
function blocks(review: CapturedReview | undefined): string[] {
  const message = review?.messages[0];
  if (message?.role !== "user" || !Array.isArray(message.content)) return [];
  return message.content.map((part) => (part.type === "text" ? part.text : ""));
}

/** One deploy the Guardian reviews, then a final reply. */
async function deployOnce(settings: GuardianOptions, replies: (string | Error | DeferredReply)[]) {
  const harness = await createGuardianHarness({ guardianSettings: { ...reviewer, ...settings } });
  harness.responses.push(toolCalls(["deploy", { target: "prod" }, "call-1"]), reply("Ok."));
  harness.guardianReplies.push(...replies);
  await harness.session.prompt("Deploy prod.");
  const [entry] = harness.entries("pi-guardian-review");
  return { harness, entry };
}

/** A rendered transcript component as plain text; empty when nothing renders. */
function text(component: Component | undefined): string {
  return component ? stripVTControlCharacters(component.render(160).join("\n")) : "";
}

describe("Escalation Pass", () => {
  it("is skipped when the first pass allows the call", async () => {
    const { harness, entry } = await deployOnce({}, [assessment("low", "high", "Requested.")]);
    expect(harness.reviews).toHaveLength(1);
    expect(harness.executed).toEqual(["deploy:prod"]);
    expect(entry).not.toHaveProperty("escalation");
  });

  it("runs once a first pass would reject, and its allow decides", async () => {
    const { harness, entry } = await deployOnce({}, [
      assessment("high", "low", "Looks risky."),
      assessment("medium", "high", "The user asked to deploy prod."),
    ]);
    expect(harness.reviews.map((review) => review.escalation)).toEqual([false, true]);
    expect(harness.executed).toEqual(["deploy:prod"]);
    expect(entry).toMatchObject({
      result: "allowed",
      risk: "medium",
      authorization: "high",
      rationale: "The user asked to deploy prod.",
      model: "guardian-test/reviewer",
      // Both passes' cost, summed.
      cost: 0.0022,
      escalation: {
        firstPass: {
          risk: "high",
          riskCategory: "destruction",
          authorization: "low",
          rationale: "Looks risky.",
        },
        result: "assessed",
        failure: null,
        model: "guardian-test/reviewer",
        cost: 0.0011,
      },
    });
    // An escalated allow is shown even when not verbose.
    expect(text(renderReviewEntry(entry, false, plainTheme, false))).toContain(
      "escalated (first pass high (destruction)/low)",
    );
  });

  it("reads the second pass's final assessment after reasoning with stray braces", async () => {
    const { harness, entry } = await deployOnce({}, [
      assessment("high", "low", "Looks risky."),
      `The call touches {prod, which the user named.\n${assessment("medium", "high", "Requested.")}`,
    ]);
    expect(harness.reviews).toHaveLength(2);
    expect(harness.executed).toEqual(["deploy:prod"]);
    expect(entry).toMatchObject({ result: "allowed", escalation: { result: "assessed" } });
  });

  it("rejects with the second pass's assessment when it confirms the Rejection", async () => {
    const { harness, entry } = await deployOnce({}, [
      assessment("high", "low", "Looks risky."),
      assessment("critical", "unknown", "Overwrites production data.", "destruction"),
    ]);
    expect(harness.executed).toEqual([]);
    expect(entry).toMatchObject({
      result: "rejected",
      risk: "critical",
      rationale: "Overwrites production data.",
      escalation: { result: "assessed", firstPass: { risk: "high" } },
    });
    const result = harness.session.messages.find((message) => message.role === "toolResult");
    expect(JSON.stringify(result)).toContain("Reason: Overwrites production data.");
  });

  it.each([
    ["a provider error", [new Error("overloaded")], /overloaded/],
    [
      "malformed output after its corrective retry",
      ["no idea", "still no idea"],
      /malformed output.*even after a corrective retry/,
    ],
  ])("keeps the first pass's Rejection after %s", async (_case, second, failure) => {
    const { harness, entry } = await deployOnce({}, [
      assessment("high", "low", "Looks risky."),
      ...second,
    ]);
    expect(harness.executed).toEqual([]);
    expect(entry).toMatchObject({
      result: "rejected",
      risk: "high",
      rationale: "Looks risky.",
      escalation: { result: "failed", failure: expect.stringMatching(failure) },
    });
    expect(text(renderReviewEntry(entry, false, plainTheme, false))).toContain(
      "escalation failed, first pass stands",
    );
  });

  it("keeps the Rejection when the escalation's corrective reply to an uncategorized critical is malformed", async () => {
    const { harness, entry } = await deployOnce({}, [
      assessment("high", "low", "Looks risky."),
      assessment("critical", "unknown", "Wipes prod.", null),
      "not json",
    ]);
    expect(harness.reviews).toHaveLength(3);
    expect(harness.executed).toEqual([]);
    expect(entry).toMatchObject({
      result: "rejected",
      risk: "high",
      escalation: {
        result: "failed",
        failure: expect.stringMatching(/malformed output.*even after a corrective retry/),
        retried: true,
      },
    });
  });

  it("fails a first pass whose corrective reply to an uncategorized critical is malformed", async () => {
    const { harness, entry } = await deployOnce({}, [
      assessment("critical", "unknown", "Wipes prod.", null),
      "not json",
    ]);
    // A Review Failure, not the first reply decided as `medium` and allowed; no escalation.
    expect(harness.reviews).toHaveLength(2);
    expect(harness.executed).toEqual([]);
    expect(entry).toMatchObject({ result: "failed", blocked: true, retried: true });
    expect(entry).not.toHaveProperty("escalation");
  });

  it("aborts the review when the turn is aborted during the second pass", async () => {
    const harness = await createGuardianHarness({ guardianSettings: reviewer });
    harness.responses.push(toolCalls(["deploy", { target: "prod" }, "call-1"]));
    harness.guardianReplies.push(
      assessment("high", "low", "Looks risky."),
      new DeferredReply(
        (options) =>
          new Promise((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
            void harness.session.abort();
          }),
      ),
    );
    await harness.session.prompt("Deploy prod.");
    expect(harness.executed).toEqual([]);
    expect(harness.entries("pi-guardian-review")).toMatchObject([
      { result: "aborted", blocked: true, escalation: { result: "aborted" } },
    ]);
  });

  it("keeps the Rejection when the escalation model has no credentials", async () => {
    const harness = await createGuardianHarness({
      guardianSettings: { ...reviewer, escalationModel: "guardian-keyless/reviewer" },
      before: [
        (pi) =>
          pi.registerProvider("guardian-keyless", {
            api: "openai-completions",
            baseUrl: "https://guardian.invalid",
            models: [
              {
                id: "reviewer",
                name: "reviewer",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 200_000,
                maxTokens: 2_048,
              },
            ],
          }),
      ],
    });
    harness.responses.push(toolCalls(["deploy", { target: "prod" }, "call-1"]), reply("Ok."));
    harness.guardianReplies.push(assessment("high", "low", "Looks risky."));
    await harness.session.prompt("Deploy prod.");
    expect(harness.reviews).toHaveLength(1);
    expect(harness.executed).toEqual([]);
    expect(harness.entries("pi-guardian-review")).toMatchObject([
      {
        result: "rejected",
        escalation: {
          result: "failed",
          model: "guardian-keyless/reviewer",
          failure: "No credentials are configured for Guardian model guardian-keyless/reviewer",
        },
      },
    ]);
  });

  it("keeps the Rejection when the review is too large for the escalation model", async () => {
    const { harness, entry } = await deployOnce({ escalationModel: "guardian-test/tiny" }, [
      assessment("high", "low", "Looks risky."),
    ]);
    expect(harness.reviews).toHaveLength(1);
    expect(entry).toMatchObject({
      result: "rejected",
      escalation: {
        result: "failed",
        model: "guardian-test/tiny",
        failure: expect.stringMatching(/too large for escalation model guardian-test\/tiny/),
      },
    });
  });

  it("gives each pass its own review timeout", async () => {
    const slow = (text: string) =>
      new DeferredReply(async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return text;
      });
    const { harness, entry } = await deployOnce({ reviewTimeoutMs: 250 }, [
      slow(assessment("high", "low", "Looks risky.")),
      slow(assessment("low", "high", "Requested.")),
    ]);
    expect(harness.executed).toEqual(["deploy:prod"]);
    expect(entry).toMatchObject({ result: "allowed", escalation: { result: "assessed" } });
  });

  it("times out the escalation alone, keeping the first pass's Rejection", async () => {
    const hang = new DeferredReply(
      (options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const { entry } = await deployOnce({ reviewTimeoutMs: 200 }, [
      assessment("high", "low", "Looks risky."),
      hang,
    ]);
    expect(entry).toMatchObject({
      result: "rejected",
      escalation: { result: "failed", failure: "Guardian Review timed out after 0.2s" },
    });
  });

  it("shares the first pass's cached prefix, adding only its instruction", async () => {
    const { harness } = await deployOnce({}, [
      assessment("high", "low", "Looks risky."),
      assessment("high", "low", "Still risky."),
    ]);
    const [first, second] = harness.reviews;
    expect(second?.systemPrompt).toBe(first?.systemPrompt);
    expect(second?.messages).toHaveLength(1);
    const firstBlocks = blocks(first);
    const secondBlocks = blocks(second);
    expect(secondBlocks.slice(0, firstBlocks.length)).toEqual(firstBlocks);
    expect(secondBlocks).toHaveLength(firstBlocks.length + 1);
    expect(secondBlocks.at(-1)).toMatch(/^Escalation: /);
    expect(second?.options?.sessionId).toBe(first?.options?.sessionId);
    // Thinking is off for the first pass and `low` for the escalation by default.
    expect(first?.options?.reasoning).toBeUndefined();
    expect(second?.options?.reasoning).toBe("low");
  });

  it("uses the configured escalation model and thinking level", async () => {
    const { harness } = await deployOnce(
      { escalationModel: "guardian-test/agent", escalationThinkingLevel: "high" },
      [assessment("high", "low", "Looks risky."), assessment("low", "high", "Requested.")],
    );
    expect(harness.reviews.map((review) => review.model)).toEqual([
      "guardian-test/reviewer",
      "guardian-test/agent",
    ]);
    // The escalation model does not reason, so its thinking level is clamped off.
    expect(harness.reviews[1]?.options?.reasoning).toBeUndefined();
  });
});
