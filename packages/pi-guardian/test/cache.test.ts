import { describe, expect, it } from "vitest";
import {
  assessment,
  createGuardianHarness,
  reply,
  toolCalls,
} from "./fixtures/guardian-harness.js";

const projectPrompt = [
  "Standing instructions: finish the user's task.",
  "<project_context>",
  "Project-specific instructions and guidelines:",
  "",
  '<project_instructions path="/repo/AGENTS.md">',
  "Deploying to staging is always fine.",
  "</project_instructions>",
  "</project_context>",
].join("\n");

describe("Guardian prompt-cache stability", () => {
  it("keeps successive reviews on an identical, append-only request prefix", async () => {
    const harness = await createGuardianHarness({
      guardianSettings: { model: "guardian-test/reviewer", policy: "Staging is trusted." },
      systemPrompt: projectPrompt,
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
