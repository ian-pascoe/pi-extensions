import { describe, expect, it } from "vitest";
import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import {
  assessment,
  createGuardianHarness,
  GatedReply,
  reply,
  toolCalls,
} from "./fixtures/guardian-harness.js";

const reviewer = { model: "guardian-test/reviewer" } as const;
const allowed = () => new GatedReply(assessment("low", "high", "Requested."));

/** A parallel batch of deploys, one per target. */
function deploys(...targets: string[]) {
  return toolCalls(
    ...targets.map((target): [string, { target: string }, string] => [
      "deploy",
      { target },
      `call-${target}`,
    ]),
  );
}

/** Let pending work settle: enough macrotasks for any request that could start to have started. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

describe("staggered sibling reviews", () => {
  it("starts siblings only once the first request streams, then runs them concurrently", async () => {
    const harness = await createGuardianHarness({
      guardianSettings: { ...reviewer, reviewTimeoutMs: 5_000 },
    });
    const [first, second, third] = [allowed(), allowed(), allowed()];
    harness.guardianReplies.push(first, second, third);
    harness.responses.push(deploys("a", "b", "c"), reply("Ok."));
    const prompt = harness.session.prompt("Deploy a, b, and c.");

    await first.requested;
    await settle();
    // The first request has been sent but has not begun to stream: its siblings wait.
    expect(harness.reviews).toHaveLength(1);

    first.begin();
    await Promise.all([second.requested, third.requested]);
    // Both siblings started while the first, and each other, were still in flight.
    expect(harness.reviews).toHaveLength(3);
    for (const gated of [first, second, third]) expect(gated.signal?.aborted).toBe(false);

    for (const gated of [second, third, first]) gated.complete();
    await prompt;
    expect(harness.executed.toSorted()).toEqual(["deploy:a", "deploy:b", "deploy:c"]);
    expect(harness.entries("pi-guardian-review")).toHaveLength(3);
  });

  it("still starts at most four early reviews at once", async () => {
    const harness = await createGuardianHarness({
      guardianSettings: { ...reviewer, reviewTimeoutMs: 5_000 },
    });
    const gated = Array.from({ length: 6 }, allowed);
    harness.guardianReplies.push(...gated);
    harness.responses.push(deploys("a", "b", "c", "d", "e", "f"), reply("Ok."));
    const prompt = harness.session.prompt("Deploy six.");
    await gated[0]?.requested;
    gated[0]?.begin();
    await Promise.all(gated.slice(1, 4).map((entry) => entry.requested));
    await settle();
    expect(harness.reviews).toHaveLength(4);
    // Each slot a finished review frees starts the next waiting one.
    for (const entry of gated) {
      await entry.requested;
      entry.complete();
    }
    await prompt;
    expect(harness.executed).toHaveLength(6);
  });

  it("releases siblings when the first request fails before streaming", async () => {
    const harness = await createGuardianHarness({
      guardianSettings: { ...reviewer, reviewTimeoutMs: 5_000 },
    });
    const [first, second] = [allowed(), allowed()];
    harness.guardianReplies.push(first, second);
    harness.responses.push(deploys("a", "b"), reply("Ok."));
    const prompt = harness.session.prompt("Deploy a and b.");
    await first.requested;
    await settle();
    expect(harness.reviews).toHaveLength(1);

    // Its first event is the error: no `start` ever came.
    first.fail("Provider unavailable");
    await second.requested;
    second.complete();
    await prompt;
    // The failed review blocks its call (headless); the sibling is reviewed and runs.
    expect(harness.executed).toEqual(["deploy:b"]);
    expect(harness.entries("pi-guardian-review")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ toolCallId: "call-a", result: "failed" }),
        expect.objectContaining({ toolCallId: "call-b", result: "allowed" }),
      ]),
    );
  });

  it("releases siblings when the first request never streams and times out", async () => {
    const harness = await createGuardianHarness({
      guardianSettings: { ...reviewer, reviewTimeoutMs: 150 },
    });
    const [first, second] = [allowed(), allowed()];
    harness.guardianReplies.push(first, second);
    harness.responses.push(deploys("a", "b"), reply("Ok."));
    const prompt = harness.session.prompt("Deploy a and b.");
    await first.requested;
    await settle();
    expect(harness.reviews).toHaveLength(1);

    // Nothing ever arrives from the first request; its deadline ends it and frees the sibling.
    await second.requested;
    expect(first.signal?.aborted).toBe(true);
    second.complete();
    await prompt;
    expect(harness.executed).toEqual(["deploy:b"]);
    expect(harness.entries("pi-guardian-review")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ toolCallId: "call-a", result: "failed" }),
        expect.objectContaining({ toolCallId: "call-b", result: "allowed" }),
      ]),
    );
  });

  it("does not deadlock when the Guarded Agent is aborted while siblings wait", async () => {
    const harness = await createGuardianHarness({
      guardianSettings: { ...reviewer, reviewTimeoutMs: 60_000 },
    });
    const [first, second] = [allowed(), allowed()];
    harness.guardianReplies.push(first, second);
    harness.responses.push(deploys("a", "b"), reply("Ok."));
    const prompt = harness.session.prompt("Deploy a and b.");
    await first.requested;
    await settle();
    expect(harness.reviews).toHaveLength(1);

    await harness.session.abort();
    await prompt;
    // The aborted siblings never reach the provider, and no call runs.
    expect(harness.reviews).toHaveLength(1);
    expect(harness.executed).toEqual([]);
  });

  it("releases siblings when the first early review is discarded before it streams", async () => {
    const harness = await createGuardianHarness({
      guardianSettings: { ...reviewer, reviewTimeoutMs: 60_000 },
      before: [
        (pi) => {
          // Another extension rewrites the first call's arguments, so Guardian discards its early
          // review and reviews the call afresh.
          pi.on("tool_call", (event: ToolCallEvent) => {
            if (event.toolName === "deploy" && event.toolCallId === "call-a")
              event.input["target"] = "rewritten";
          });
        },
      ],
    });
    const gated = [allowed(), allowed(), allowed()];
    harness.guardianReplies.push(...gated);
    harness.responses.push(deploys("a", "b"), reply("Ok."));
    const prompt = harness.session.prompt("Deploy a and b.");
    const [first] = gated;
    await first?.requested;
    // The first request never began streaming: discarding it aborts it, which frees the sibling
    // (and the rewritten call's fresh review) instead of waiting for its deadline.
    await Promise.all(gated.map((entry) => entry.requested));
    expect(first?.signal?.aborted).toBe(true);
    for (const entry of gated) entry.complete();
    await prompt;
    expect(harness.executed.toSorted()).toEqual(["deploy:b", "deploy:rewritten"]);
  });

  it("leaves a sequential batch's single early review unchanged", async () => {
    const harness = await createGuardianHarness({
      guardianSettings: { ...reviewer, reviewTimeoutMs: 5_000 },
    });
    // Pi runs a one-call-at-a-time batch in order, so a later call's review must see the earlier
    // results: only the first call is reviewed early, and nothing waits on its stream.
    harness.session.agent.toolExecution = "sequential";
    const [first, second] = [allowed(), allowed()];
    harness.guardianReplies.push(first, second);
    harness.responses.push(deploys("a", "b"), reply("Ok."));
    const prompt = harness.session.prompt("Deploy a, then b.");
    await first.requested;
    await settle();
    expect(harness.reviews).toHaveLength(1);
    first.complete();
    await second.requested;
    // The second review started at its own preflight, after the first call ran.
    expect(harness.executed).toEqual(["deploy:a"]);
    second.complete();
    await prompt;
    expect(harness.executed).toEqual(["deploy:a", "deploy:b"]);
    expect(harness.reviews).toHaveLength(2);
  });
});
