import { stripVTControlCharacters } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { renderReviewEntry } from "../src/guardian-rendering.js";
import type { GuardianOptions } from "../src/guardian-settings.js";
import {
  assessment,
  classified,
  createGuardianHarness,
  reply,
  toolCalls,
  type ClassifierReply,
} from "./fixtures/guardian-harness.js";

const settings = {
  classifierModel: "guardian-test/judge",
  model: "guardian-test/reviewer",
  thinkingLevel: "off",
} as const satisfies GuardianOptions;

beforeAll(() => initTheme("dark"));

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

/** A rendered transcript component as plain text; empty when nothing renders. */
function text(component: Component | undefined): string {
  return component ? stripVTControlCharacters(component.render(400).join("\n")) : "";
}

/** One deploy the Guardian reviews with a classifier First Pass, then a final reply. */
async function deployOnce(
  classifierReplies: ClassifierReply[],
  guardianReplies: string[] = [],
  overrides: GuardianOptions = {},
  base: GuardianOptions = settings,
) {
  const harness = await createGuardianHarness({
    guardianSettings: { ...base, ...overrides },
  });
  harness.responses.push(toolCalls(["deploy", { target: "prod" }, "call-1"]), reply("Ok."));
  harness.classifierReplies.push(...classifierReplies);
  harness.guardianReplies.push(...guardianReplies);
  await harness.session.prompt("Deploy prod.");
  const [entry] = harness.entries("pi-guardian-review");
  return { harness, entry };
}

describe("Classifier First Pass", () => {
  it("decides a confident allow without a language model", async () => {
    const { harness, entry } = await deployOnce([
      classified({ low: 0.9, medium: 0.1 }, { high: 0.8, medium: 0.2 }),
    ]);
    expect(harness.classifications.map((request) => request.model)).toEqual([
      "guardian-test/judge",
    ]);
    expect(harness.reviews).toEqual([]);
    expect(harness.executed).toEqual(["deploy:prod"]);
    expect(entry).toMatchObject({
      result: "allowed",
      risk: "low",
      authorization: "high",
      model: "guardian-test/judge",
      classification: { rejectionProbability: 0, threshold: 0.2, failure: null },
    });
    expect(entry).not.toHaveProperty("escalation");
  });

  it("escalates an allow whose Rejection Probability reaches the threshold", async () => {
    const { harness, entry } = await deployOnce(
      [
        classified(
          { low: 0.6, high: 0.4 },
          { high: 0.5, low: 0.4, unknown: 0.1 },
          { destruction: 1 },
        ),
      ],
      [assessment("medium", "high", "The user asked to deploy prod.")],
    );
    expect(harness.reviews.map((review) => [review.model, review.escalation])).toEqual([
      ["guardian-test/reviewer", true],
    ]);
    expect(harness.executed).toEqual(["deploy:prod"]);
    expect(entry).toMatchObject({
      result: "allowed",
      risk: "medium",
      rationale: "The user asked to deploy prod.",
      model: "guardian-test/judge",
      classification: { rejectionProbability: 0.2, threshold: 0.2 },
      escalation: {
        trigger: "uncertain",
        firstPass: { risk: "low", authorization: "high" },
        result: "assessed",
        model: "guardian-test/reviewer",
      },
    });
  });

  it("hides an escalation that resolved the classifier's doubt unless verbose", async () => {
    const { entry } = await deployOnce(
      [classified({ low: 0.6, high: 0.4 }, { high: 0.5, low: 0.5 }, { destruction: 1 })],
      [assessment("low", "high", "Routine.")],
    );
    expect(text(renderReviewEntry(entry, false, plainTheme, false))).toBe("");
    expect(text(renderReviewEntry(entry, false, plainTheme, true))).toContain(
      "escalated (classifier unsure: low/low)",
    );
  });

  it("escalates a would-be Rejection, which stands when the Escalation Pass fails", async () => {
    const { harness, entry } = await deployOnce(
      [classified({ critical: 0.9, high: 0.1 }, { unknown: 1 }, { destruction: 1 })],
      ["no idea", "still no idea"],
    );
    expect(harness.executed).toEqual([]);
    expect(entry).toMatchObject({
      result: "rejected",
      risk: "critical",
      riskCategory: "destruction",
      rationale: "",
      escalation: { trigger: "rejected", result: "failed" },
    });
    const result = harness.session.messages.find((message) => message.role === "toolResult");
    expect(JSON.stringify(result)).toContain("Reason: The Guardian gave no specific rationale.");
    expect(text(renderReviewEntry(entry, false, plainTheme, false))).toContain(
      "escalation failed, first pass stands (first pass critical (destruction)/unknown)",
    );
  });

  it("escalates high risk without a Risk Category instead of deciding it as medium", async () => {
    const { harness, entry } = await deployOnce(
      [classified({ high: 1 }, { medium: 1 })],
      [assessment("high", "low", "Deploying prod is destructive here.")],
    );
    expect(harness.executed).toEqual([]);
    expect(entry).toMatchObject({
      result: "rejected",
      escalation: {
        trigger: "uncategorized",
        firstPass: { risk: "high", authorization: "medium" },
      },
    });
    expect(entry).not.toHaveProperty("downgraded");
  });

  it.each([
    ["it is unsure", classified({ low: 0.5, critical: 0.5 }, { high: 1 }, { destruction: 1 })],
    ["it names no Risk Category", classified({ critical: 1 }, { high: 1 })],
  ])("makes a failed escalation a Review Failure when %s", async (_case, classification) => {
    const { harness, entry } = await deployOnce([classification], [], {});
    expect(harness.executed).toEqual([]);
    expect(entry).toMatchObject({
      result: "failed",
      risk: null,
      failure: expect.stringMatching(/the Escalation Pass failed: .*No scripted Guardian reply/),
    });
  });

  it.each([
    ["a provider error", [new Error("overloaded")], /request failed: overloaded/],
    ["an invalid answer", [{}], /gave no valid risk_level answer/],
  ])("escalates after %s, and the Escalation Pass decides", async (_case, replies, failure) => {
    const { harness, entry } = await deployOnce(replies, [assessment("low", "high", "Routine.")]);
    expect(harness.executed).toEqual(["deploy:prod"]);
    expect(entry).toMatchObject({
      result: "allowed",
      model: "guardian-test/judge",
      classification: { rejectionProbability: null, failure: expect.stringMatching(failure) },
      escalation: { trigger: "failed", firstPass: null, result: "assessed" },
    });
    // A failed classifier is always shown, even when the Escalation Pass allowed the call.
    expect(text(renderReviewEntry(entry, false, plainTheme, false))).toContain(
      "escalated (classifier failed)",
    );
  });

  it("is a Review Failure when both the classifier and the Escalation Pass fail", async () => {
    const { harness, entry } = await deployOnce([new Error("overloaded")], []);
    expect(harness.executed).toEqual([]);
    expect(entry).toMatchObject({
      result: "failed",
      failure: expect.stringMatching(
        /request failed: overloaded, and the Escalation Pass failed: .*No scripted Guardian reply/,
      ),
    });
  });

  it.each([
    ["is not found", { classifierModel: "guardian-test/missing" }, /classifier .* not found/],
    [
      "cannot hold the call",
      { classifierModel: "guardian-test/tiny-judge" },
      /too large for Guardian classifier guardian-test\/tiny-judge/,
    ],
  ])("escalates when the classifier %s", async (_case, overrides, failure) => {
    const { harness, entry } = await deployOnce(
      [],
      [assessment("low", "high", "Routine.")],
      overrides,
    );
    expect(harness.classifications).toEqual([]);
    expect(harness.executed).toEqual(["deploy:prod"]);
    expect(entry).toMatchObject({
      result: "allowed",
      classification: { failure: expect.stringMatching(failure) },
      escalation: { trigger: "failed" },
    });
  });

  it("escalates to the session model when no language model is configured", async () => {
    const { harness } = await deployOnce(
      [new Error("overloaded")],
      [assessment("low", "high", "Routine.")],
      {},
      { classifierModel: "guardian-test/judge" },
    );
    expect(harness.reviews.map((review) => review.model)).toEqual(["guardian-test/agent"]);
  });

  it("judges the Security Policy, the evidence, and the Reviewed Call with three questions", async () => {
    const { harness } = await deployOnce(
      [classified({ low: 1 }, { high: 1 }, { none: 1 }, [])],
      [],
      { policy: "Never deploy on Fridays." },
    );
    const [request] = harness.classifications;
    expect(request?.context.state).toMatchObject({
      securityPolicy: "Never deploy on Fridays.",
      evidence: [expect.stringContaining("Deploy prod.")],
      reviewedCall: expect.stringContaining('Arguments: {"target":"prod"}'),
    });
    expect(Object.keys(request?.context.questions ?? {})).toEqual([
      "risk_level",
      "user_authorization",
      "risk_category",
    ]);
    expect(Object.keys(request?.context.questions.risk_category?.criteria ?? {})).toContain(
      "security_policy",
    );
  });
});
