import { describe, expect, it } from "vitest";
import {
  assessment,
  createGuardianHarness,
  reply,
  toolCalls,
} from "./fixtures/guardian-harness.js";

/** The text of a tool result in the agent's transcript. */
function resultText(
  harness: Awaited<ReturnType<typeof createGuardianHarness>>,
  toolCallId: string,
) {
  for (const message of harness.session.messages) {
    if (message.role === "toolResult" && message.toolCallId === toolCallId)
      return {
        isError: message.isError,
        text: message.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
      };
  }
  return undefined;
}

describe("Guardian through the native SDK", () => {
  it("runs allowed tools without review and a low-risk Reviewed Call after review", async () => {
    const harness = await createGuardianHarness({
      guardianSettings: { model: "guardian-test/reviewer" },
    });
    harness.responses.push(
      toolCalls(["lookup", { query: "x" }, "call-lookup"]),
      toolCalls(["deploy", { target: "staging" }, "call-deploy"]),
      reply("Done."),
    );
    harness.guardianReplies.push(assessment("low", "high", "The user asked to deploy staging."));
    await harness.session.prompt("Look up x, then deploy staging.");

    expect(harness.executed).toEqual(["lookup:x", "deploy:staging"]);
    expect(harness.reviews).toHaveLength(1);
    expect(harness.reviews[0]?.model).toBe("guardian-test/reviewer");
    // Low thinking by default for reasoning-capable Guardian models.
    expect(harness.reviews[0]?.options?.reasoning).toBe("low");
    const [entry] = harness.entries("pi-guardian-review");
    expect(entry).toMatchObject({
      toolName: "deploy",
      toolCallId: "call-deploy",
      result: "allowed",
      risk: "low",
      authorization: "high",
      blocked: false,
      userOverride: false,
      model: "guardian-test/reviewer",
      cost: 0.0011,
      usage: { total: 1_050 },
    });
    // Review entries never reach the model.
    expect(JSON.stringify(harness.agentRequests.at(-1))).not.toContain("pi-guardian");
  });

  it("blocks a Rejection with Codex-style feedback and records it", async () => {
    const harness = await createGuardianHarness({
      guardianSettings: { model: "guardian-test/reviewer" },
    });
    harness.responses.push(toolCalls(["deploy", { target: "production" }, "call-1"]), reply("Ok."));
    harness.guardianReplies.push(
      assessment("high", "low", "Deploying production was not requested."),
    );
    await harness.session.prompt("Deploy staging.");

    expect(harness.executed).toEqual([]);
    expect(resultText(harness, "call-1")).toEqual({
      isError: true,
      text: [
        "This action was rejected due to unacceptable risk.",
        "Risk: high (destruction). Authorization: low.",
        "Reason: Deploying production was not requested.",
        "Do not attempt to achieve the same outcome through a workaround, indirect execution, or variations of this call, and do not retry it. Explain the risk to the user and ask whether they want to proceed; continue only with a materially safer alternative or after the user explicitly approves this action.",
      ].join("\n"),
    });
    expect(harness.entries("pi-guardian-review")).toMatchObject([
      {
        result: "rejected",
        risk: "high",
        riskCategory: "destruction",
        authorization: "low",
        blocked: true,
      },
    ]);
  });
});
