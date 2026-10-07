import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  assessment,
  createGuardianHarness,
  reply,
  toolCalls,
} from "./fixtures/guardian-harness.js";

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
