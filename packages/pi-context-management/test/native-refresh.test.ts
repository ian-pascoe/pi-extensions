import { chmodSync } from "node:fs";
import { expect, test } from "vitest";
import { SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import contextManagement from "../src/context-management-extension.js";
import { createSdkHarness, overflow, reply, toolCall } from "./sdk-harness.js";

test("disabling native automatic compaction still permits explicit Rollover", async () => {
  const f = await createSdkHarness([contextManagement]);
  f.settings.setCompactionEnabled(false);
  f.responses.push(reply("Existing work", 199_700));
  await f.session.prompt("Original task");
  expect(f.requests).toHaveLength(1);
  expect(f.manager.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
  f.responses.push(
    toolCall("context_rollover", { handoff: "Explicit continuation" }),
    reply("Continued"),
  );
  await f.session.prompt("/rollover");
  await expect.poll(() => f.requests.length).toBe(3);
  await f.session.waitForIdle();
  expect(f.manager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(1);
  expect(f.providerRequests).toEqual([]);
  expect(f.extensionErrors).toEqual([]);
});

test.each([false, true])(
  "native threshold prepares Notes and a fresh Handoff before one Rollover (idle=%s)",
  async (idle) => {
    const f = await createSdkHarness([contextManagement]);
    const note = toolCall("context_notes", {
      action: "write",
      name: "task",
      content: "Recent decisions",
    });
    note.usage = reply("", 199_700).usage;
    if (idle) {
      f.settings.setCompactionEnabled(false);
      f.responses.push(reply("Existing work", 199_700));
      await f.session.prompt("Original task");
      f.settings.setCompactionEnabled(true);
    } else f.responses.push(reply("Existing work", 199_700));
    f.responses.push(
      note,
      toolCall("context_rollover", { handoff: "Fresh continuation" }),
      reply("Continued"),
    );
    await f.session.prompt(idle ? "New instruction" : "Original task");
    expect(f.requests).toHaveLength(4);
    if (idle) expect(JSON.stringify(f.requests[1]?.messages)).toContain("New instruction");
    expect(JSON.stringify(f.requests[1]?.messages)).toContain("Prepare a Context Rollover");
    expect(JSON.stringify(f.requests[3]?.messages)).toContain("Fresh continuation");
    expect(f.manager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(1);
    expect(f.providerRequests).toEqual([]);
    expect(f.extensionErrors).toEqual([]);
  },
);

test.each(["stop", "aborted"] as const)(
  "an unfinished refresh (%s) preserves History and does not nudge again",
  async (stopReason) => {
    const f = await createSdkHarness([contextManagement]);
    const notices: string[] = [];
    f.session.extensionRunner.setUIContext(
      {
        ...f.session.extensionRunner.getUIContext(),
        notify: (message) => {
          notices.push(message);
        },
      },
      "rpc",
    );
    const unfinished = reply("No Handoff", 199_700);
    unfinished.stopReason = stopReason;
    f.responses.push(reply("Existing work", 199_700), unfinished);
    await f.session.prompt("Original task");
    expect(f.requests).toHaveLength(2);
    expect(f.manager.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
    expect(JSON.stringify(f.session.messages)).toContain("Original task");
    expect(
      notices.filter((message) => message.includes("Rollover was not completed")),
    ).toHaveLength(1);
    expect(f.session.agent.hasQueuedMessages()).toBe(false);
    f.responses.push(reply("Continue without a checkpoint", 199_700));
    await f.session.prompt("Keep working");
    expect(f.requests).toHaveLength(3);
    expect(notices.filter((message) => message.includes("Preparing Notes"))).toHaveLength(1);
    expect(f.session.agent.hasQueuedMessages()).toBe(false);
    expect(f.manager.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
    expect(f.providerRequests).toEqual([]);
  },
);

test("a preparation blocked by another input handler does not suppress later preparation", async () => {
  let block = true;
  const f = await createSdkHarness([
    contextManagement,
    (pi) => {
      pi.on("input", (event) =>
        event.source === "extension" && block ? { action: "handled" } : undefined,
      );
    },
  ]);
  const notices: string[] = [];
  f.session.extensionRunner.setUIContext(
    {
      ...f.session.extensionRunner.getUIContext(),
      notify: (message) => {
        notices.push(message);
      },
    },
    "rpc",
  );
  await f.session.prompt("/rollover");
  await expect
    .poll(() => notices.some((message) => message.includes("Rollover was not completed")))
    .toBe(true);
  expect(f.requests).toHaveLength(0);
  block = false;
  f.responses.push(
    toolCall("context_rollover", { handoff: "Fresh continuation" }),
    reply("Continued"),
  );
  await f.session.prompt("/rollover");
  await expect.poll(() => f.requests.length).toBe(2);
  await f.session.waitForIdle();
  expect(f.manager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(1);
});

test("cancelling queued preparation prevents its request and records cancellation for later prompts", async () => {
  let cancelled = false;
  const f = await createSdkHarness([
    contextManagement,
    (pi) => {
      pi.on("session_compact_failed", (event, ctx) => {
        if (event.reason === "threshold" && !cancelled) {
          cancelled = true;
          pi.sendMessage({
            customType: "companion",
            content: "Queued input survives",
            display: true,
          });
          ctx.abort();
        }
      });
    },
  ]);
  const notices: string[] = [];
  f.session.extensionRunner.setUIContext(
    {
      ...f.session.extensionRunner.getUIContext(),
      notify: (message) => {
        notices.push(message);
      },
    },
    "rpc",
  );
  f.responses.push(reply("Ready", 199_700));
  await f.session.prompt("Original task");
  expect(cancelled).toBe(true);
  expect(f.requests).toHaveLength(1);
  expect(f.session.agent.hasQueuedMessages()).toBe(false);
  expect(notices.filter((message) => message.includes("Rollover was not completed"))).toHaveLength(
    1,
  );
  f.responses.push(reply("Kept working", 199_700));
  await f.session.prompt("Keep working without Rollover");
  expect(f.requests).toHaveLength(2);
  expect(JSON.stringify(f.requests[1]?.messages)).toContain("Rollover preparation was cancelled");
  expect(JSON.stringify(f.requests[1]?.messages)).toContain("Queued input survives");
  expect(notices.filter((message) => message.includes("Preparing Notes"))).toHaveLength(1);
  const reopened = SessionManager.open(f.manager.getSessionFile()!);
  expect(JSON.stringify(reopened.buildSessionContext())).toContain(
    "Rollover preparation was cancelled",
  );
  expect(f.manager.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
  expect(f.providerRequests).toEqual([]);
});

test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "a cancellation-status write failure quarantines subsequent prompts across reload",
  async () => {
    const f = await createSdkHarness([
      contextManagement,
      (pi) => {
        pi.on("session_compact_failed", (event, ctx) => {
          if (event.reason === "threshold") ctx.abort();
        });
      },
    ]);
    const append = f.manager.appendCustomMessageEntry.bind(f.manager);
    f.manager.appendCustomMessageEntry = (...args) => {
      if (args[0] !== "pi-context-prepare-cancelled") return append(...args);
      const file = f.manager.getSessionFile()!;
      chmodSync(file, 0o400);
      try {
        return append(...args);
      } finally {
        chmodSync(file, 0o600);
      }
    };
    f.responses.push(reply("Ready", 199_700));
    await f.session.prompt("Original task");
    expect(f.requests).toHaveLength(1);
    const leaf = f.manager.getLeafId();
    f.responses.push(reply("Must not execute"));
    await f.session.prompt("Must remain stopped");
    expect(f.requests).toHaveLength(1);
    expect(f.manager.getLeafId()).toBe(leaf);
    await f.session.reload();
    await f.session.prompt("Still stopped after reload");
    expect(f.requests).toHaveLength(1);
    expect(f.providerRequests).toEqual([]);
  },
);

test("native manual instructions are not restricted by the /rollover command limit", async () => {
  const f = await createSdkHarness([contextManagement]);
  f.responses.push(reply("Ready"));
  await f.session.prompt("Original task " + "history ".repeat(3000));
  f.responses.push(
    toolCall("context_rollover", { handoff: "Fresh continuation" }),
    reply("Continued"),
  );
  const instructions = "X".repeat(2001);
  await expect(f.session.compact(instructions)).rejects.toThrow("Compaction cancelled");
  await f.session.waitForIdle();
  expect(f.requests).toHaveLength(3);
  expect(JSON.stringify(f.requests[1]?.messages)).toContain(instructions);
  expect(f.manager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(1);
  await f.session.prompt("/rollover " + instructions);
  await f.session.waitForIdle();
  expect(f.requests).toHaveLength(3);
  expect(f.providerRequests).toEqual([]);
});

test("native length recovery does not restore the truncated response on resume", async () => {
  const f = await createSdkHarness([contextManagement]);
  const truncated = reply("TRUNCATED-ASSISTANT");
  truncated.stopReason = "length";
  f.responses.push(truncated, reply("Recovered"));
  await f.session.prompt("Original task " + "history ".repeat(3000));
  expect(f.requests).toHaveLength(2);
  expect(f.manager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(1);
  expect(JSON.stringify(f.requests[1]?.messages)).not.toContain("TRUNCATED-ASSISTANT");
  const reopened = SessionManager.open(f.manager.getSessionFile()!);
  expect(reopened.buildSessionContext().messages).toEqual(f.session.messages);
  expect(JSON.stringify(reopened.buildSessionContext())).not.toContain("TRUNCATED-ASSISTANT");
  expect(JSON.stringify(reopened.getBranch())).toContain("TRUNCATED-ASSISTANT");
  expect(f.providerRequests).toEqual([]);
});

test("overflow during preparation cuts over without requesting another refresh", async () => {
  const f = await createSdkHarness([contextManagement]);
  f.responses.push(reply("Existing work", 199_700), overflow(), reply("Recovered from History"));
  await f.session.prompt("Original task");
  expect(f.requests).toHaveLength(3);
  expect(JSON.stringify(f.requests[1]?.messages)).toContain("Prepare a Context Rollover");
  expect(JSON.stringify(f.requests[2]?.messages)).not.toContain("Prepare a Context Rollover");
  expect(JSON.stringify(f.requests[2]?.messages)).toContain("saved Handoff may be stale");
  expect(f.manager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(1);
  expect(f.providerRequests).toEqual([]);
});

for (const idle of [false, true]) {
  test(`native compaction can request preparation without nesting a prompt (idle=${idle})`, async () => {
    let session: AgentSession;
    let requested = false;
    const f = await createSdkHarness(
      [
        (pi) => {
          pi.on("session_before_compact", () => {
            if (!requested) {
              requested = true;
              pi.sendMessage(
                {
                  customType: "prepare-rollover",
                  content: "Refresh Notes and Handoff first.",
                  display: true,
                },
                { deliverAs: session.isStreaming ? "steer" : "nextTurn" },
              );
            }
            return { cancel: true };
          });
        },
      ],
      { contextWindow: 20_000 },
    );
    session = f.session;
    if (idle) f.settings.setCompactionEnabled(false);
    f.responses.push(reply("Existing work", 19_800));
    if (!idle) f.responses.push(reply("Prepared"));
    await session.prompt("Original task");
    if (idle) {
      f.settings.setCompactionEnabled(true);
      f.responses.push(reply("Prepared"));
      await session.prompt("New instruction");
    }
    expect(requested).toBe(true);
    expect(f.requests).toHaveLength(2);
    const input = JSON.stringify(f.requests[1]?.messages);
    expect(input).toContain("Refresh Notes and Handoff first.");
    expect(input).toContain(idle ? "New instruction" : "Original task");
    expect(f.extensionErrors).toEqual([]);
    expect(f.providerRequests).toEqual([]);
  });
}
