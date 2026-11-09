import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { planCheckpoint } from "../src/context-window.js";
import { createSdkHarness, reply, toolCall } from "./sdk-harness.js";

describe("Native Tail retention through the Pi SDK", () => {
  it("keeps complete tool batches even when their results exceed the native retention target", async () => {
    const f = await createSdkHarness([]);
    f.responses.push(reply("Ready"));
    await f.session.prompt("Task");
    const call = f.manager.appendMessage(toolCall("read", {}, "read-1"));
    f.manager.appendMessage({
      role: "toolResult",
      toolCallId: "read-1",
      toolName: "read",
      content: [{ type: "text", text: "result ".repeat(1000) }],
      isError: false,
      timestamp: 0,
    });
    const plan = planCheckpoint(f.manager, "Continue", "normal", 1, call);
    f.manager.appendCompaction(plan.summary, plan.firstKeptEntryId!, 100, plan.details, true);
    // Pi keeps the transcript system message that declares the prompt and tools ahead of a checkpoint.
    expect(f.manager.buildSessionContext().messages.map((message) => message.role)).toEqual([
      "system",
      "compactionSummary",
      "assistant",
      "toolResult",
    ]);
  });

  it.each(["incomplete", "orphan"])("refuses a retained %s tool batch", async (kind) => {
    const f = await createSdkHarness([]);
    f.responses.push(reply("Ready"));
    await f.session.prompt("Task");
    const call = f.manager.appendMessage(toolCall("read", {}, "read-1"));
    if (kind === "orphan") {
      const result = {
        role: "toolResult" as const,
        toolCallId: "unknown",
        toolName: "read",
        content: [{ type: "text" as const, text: "result" }],
        isError: false,
        timestamp: 0,
      };
      f.manager.appendMessage(result);
    }
    expect(() => planCheckpoint(f.manager, "Continue", "normal", 1, call)).toThrow(
      /History contains/,
    );
    expect(f.manager.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
  });

  it("does not restore a persisted aborted response during native overflow", async () => {
    const f = await createSdkHarness([]);
    f.responses.push(reply("Ready"));
    await f.session.prompt("Task");
    const failed = f.manager.appendMessage({
      ...reply("Failed partial response"),
      stopReason: "aborted",
    });
    const plan = planCheckpoint(f.manager, "Saved Handoff", "overflow", 20_000, failed);
    expect(plan.firstKeptEntryId).toBeUndefined();
    expect(plan.summary).toContain("Omitted History: context:");
  });
  it("retains Pi's latest cut point even when its message exceeds keepRecentTokens", async () => {
    const f = await createSdkHarness([], { keepRecentTokens: 1 });
    f.responses.push(reply("Latest assistant message exceeds one token."));
    await f.session.prompt("Old task to move into History");
    const latest = f.manager.getLeafId()!;
    const plan = planCheckpoint(f.manager, "Continue the task.", "normal", 1);
    expect(plan.firstKeptEntryId).toBe(latest);
    f.manager.appendCompaction(plan.summary, plan.firstKeptEntryId!, 100, plan.details, true);
    const reopened = SessionManager.open(f.manager.getSessionFile()!);
    expect(reopened.buildSessionContext().messages).toMatchObject([
      { role: "system" },
      { role: "compactionSummary", summary: expect.stringContaining("Continue the task.") },
      {
        role: "assistant",
        content: [{ type: "text", text: "Latest assistant message exceeds one token." }],
      },
    ]);
    expect(plan.summary).toContain("Recent History: context:");
    expect(f.providerRequests).toEqual([]);
  });
});
