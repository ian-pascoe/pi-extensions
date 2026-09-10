import { describe, expect, it } from "vitest";
import { buildSessionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import contextManagement from "../src/context-management-extension.js";
import { readNotes } from "../src/context-store.js";
import { createSdkHarness, overflow, reply, toolCall } from "./sdk-harness.js";

const checkpoints = (manager: SessionManager) =>
  manager.getBranch().filter((entry) => entry.type === "compaction");

describe("native Context Checkpoint lifecycle", () => {
  it.each(["manual", "threshold"])(
    "refreshes before native %s compaction without a summarizer",
    async (reason) => {
      const f = await createSdkHarness([contextManagement]);
      f.responses.push(
        reply("Ready.", reason === "threshold" ? 200_000 : 100),
        toolCall("context_rollover", { handoff: "Fresh native continuation." }),
        reply("Continued."),
      );
      await f.session.prompt("OLD-NATIVE " + "history ".repeat(12_000));
      if (reason === "manual") {
        await expect(f.session.compact()).rejects.toThrow("Compaction cancelled");
        await expect.poll(() => f.requests.length).toBe(3);
        await f.session.waitForIdle();
      }
      expect(f.requests).toHaveLength(3);
      expect(JSON.stringify(f.requests[1])).toContain("Prepare a Context Rollover");
      expect(checkpoints(f.manager)).toHaveLength(1);
      expect(checkpoints(f.manager)[0]?.details).toMatchObject({ reason: "normal" });
      expect(checkpoints(f.manager)[0]?.summary).toContain("Fresh native continuation.");
      expect(f.session.messages).toEqual(f.manager.buildSessionContext().messages);
      expect(f.providerRequests).toEqual([]);
    },
  );

  it.each([
    { partial: false, keepRecentTokens: 0 },
    { partial: true, keepRecentTokens: 0 },
    { partial: false, keepRecentTokens: 500 },
    { partial: true, keepRecentTokens: 500 },
  ])(
    "retries overflow once with no failed journal replay: %j",
    async ({ partial, keepRecentTokens }) => {
      const f = await createSdkHarness([contextManagement], { keepRecentTokens });
      f.responses.push(reply("Ready."));
      await f.session.prompt("Original task " + "history ".repeat(3000));
      f.responses.push(overflow(partial), reply("Recovered."));
      await f.session.prompt("Continue recent work " + "recent ".repeat(400));
      expect(f.requests).toHaveLength(3);
      expect(checkpoints(f.manager)).toHaveLength(1);
      expect(JSON.stringify(f.requests[2]).includes("300000 tokens")).toBe(false);
      expect(JSON.stringify(f.requests[2]).includes("never-executed")).toBe(false);
      expect(JSON.stringify(f.requests[2])).not.toContain("PROVIDER-FAILED-RESPONSE");
      expect(f.requests[2]?.messages).toHaveLength(1);
      const file = f.manager.getSessionFile();
      if (!file) throw new Error("Expected a persisted scratch session");
      const reopened = SessionManager.open(file);
      expect(JSON.stringify(reopened.buildSessionContext()).includes("300000 tokens")).toBe(false);
      expect(reopened.buildSessionContext().messages).toEqual(f.session.messages);
      expect(JSON.stringify(reopened.buildSessionContext())).not.toContain("never-executed");
      expect(JSON.stringify(reopened.buildSessionContext())).not.toContain(
        "PROVIDER-FAILED-RESPONSE",
      );
      expect(
        reopened
          .getBranch()
          .some(
            (entry) =>
              entry.type === "message" &&
              entry.message.role === "assistant" &&
              entry.message.stopReason === "error",
          ),
      ).toBe(true);
    },
  );

  it("stops on repeated overflow without another checkpoint/retry", async () => {
    const f = await createSdkHarness([contextManagement]);
    f.responses.push(overflow(), overflow());
    await f.session.prompt("Original task " + "history ".repeat(3000));
    expect(f.requests).toHaveLength(2);
    expect(checkpoints(f.manager)).toHaveLength(1);
  });

  it("does not checkpoint a cancelled standalone call or a non-isolated batch", async () => {
    const cancelled = await createSdkHarness([
      (pi) => {
        pi.on("turn_end", (event, ctx) => {
          if (
            event.message.role === "assistant" &&
            event.message.content.some((part) => part.type === "toolCall")
          )
            ctx.abort();
        });
      },
      contextManagement,
    ]);
    cancelled.responses.push(toolCall("context_rollover", { handoff: "Cancel this." }));
    await cancelled.session.prompt("Cancel before checkpoint");
    expect(cancelled.requests).toHaveLength(1);
    expect(checkpoints(cancelled.manager)).toHaveLength(0);
    const batch = await createSdkHarness([contextManagement]);
    const calls = toolCall("context_rollover", { handoff: "A" }, "a");
    calls.content.push(...toolCall("context_rollover", { handoff: "B" }, "b").content);
    batch.responses.push(calls, reply("Will request separately."));
    await batch.session.prompt("Non-isolated batch");
    expect(checkpoints(batch.manager)).toHaveLength(0);
    const results =
      batch.requests[1]?.messages.filter((message) => message.role === "toolResult") ?? [];
    expect(results).toHaveLength(2);
    expect(results.every((message) => message.role === "toolResult" && message.isError)).toBe(true);
  });

  it.each([0, 500])(
    "keeps native retention %i and branch Notes consistent across fork, tree, resume, and new",
    async (keepRecentTokens) => {
      const f = await createSdkHarness([contextManagement], { keepRecentTokens });
      f.responses.push(
        toolCall("context_notes", { action: "write", name: "task", content: "FIRST NOTE" }),
        reply("Saved."),
      );
      await f.session.prompt("Remember the first phase");
      const firstLeaf = f.manager.getLeafId();
      if (!firstLeaf) throw new Error("Expected a branch leaf");
      f.responses.push(
        toolCall("context_rollover", { handoff: "Continue second phase." }),
        reply("Continuing."),
      );
      await f.session.prompt("Roll over");
      const inherited = buildSessionContext(f.manager.getBranch()).messages;
      expect(inherited).toEqual(f.session.messages);
      expect(f.requests[3]?.messages[0]).toMatchObject({
        role: "user",
        content: [{ type: "text", text: expect.stringContaining("Context Window Handoff") }],
      });
      const retained = f.requests[3]!.messages;
      expect(retained).toContainEqual(
        expect.objectContaining({
          role: "assistant",
          content: expect.arrayContaining([
            expect.objectContaining({ type: "toolCall", name: "context_rollover", id: "call-1" }),
          ]),
        }),
      );
      expect(retained).toContainEqual(
        expect.objectContaining({
          role: "toolResult",
          toolName: "context_rollover",
          toolCallId: "call-1",
        }),
      );
      const cutoff = checkpoints(f.manager)[0]?.firstKeptEntryId;
      expect(cutoff && f.manager.getEntry(cutoff)).toBeTruthy();
      const file = f.manager.getSessionFile();
      if (!file) throw new Error("Expected a persisted scratch session");
      const fork = SessionManager.forkFrom(file, f.dir, f.dir);
      expect(JSON.stringify(fork.buildSessionContext().messages)).toBe(JSON.stringify(inherited));
      expect(readNotes(fork).map((note) => note.content)).toEqual(["FIRST NOTE"]);
      f.responses.push(
        toolCall("context_notes", { action: "write", name: "task", content: "SECOND NOTE" }),
        reply("Saved second."),
      );
      await f.session.prompt("Update Note");
      expect(readNotes(f.manager).map((note) => note.content)).toEqual(["SECOND NOTE"]);
      expect(readNotes(fork).map((note) => note.content)).toEqual(["FIRST NOTE"]);
      await f.session.navigateTree(firstLeaf, { summarize: false });
      expect(readNotes(f.manager).map((note) => note.content)).toEqual(["FIRST NOTE"]);
      expect(checkpoints(f.manager)).toHaveLength(0);
      const independent = await createSdkHarness([contextManagement]);
      expect(readNotes(independent.manager)).toEqual([]);
    },
  );
});
