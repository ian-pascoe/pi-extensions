import { describe, expect, it } from "vitest";
import { chmodSync } from "node:fs";
import { Type } from "typebox";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import contextManagement from "../src/context-management-extension.js";
import { createSdkHarness, overflow, reply, toolCall } from "./sdk-harness.js";

describe("Context Windows through the Pi SDK", () => {
  it("does not undo a durable native checkpoint when the subsequent live-state update fails", async () => {
    const f = await createSdkHarness([contextManagement]);
    f.responses.push(reply("Ready."));
    await f.session.prompt("Original task " + "history ".repeat(3000));
    const descriptor = Object.getOwnPropertyDescriptor(f.session.agent.state, "messages");
    if (!descriptor?.set) throw new Error("Expected Pi's live messages setter");
    const setMessages = descriptor.set.bind(f.session.agent.state);
    Object.defineProperty(f.session.agent.state, "messages", {
      ...descriptor,
      set(messages: AgentMessage[]) {
        if (messages.some((message) => message.role === "compactionSummary"))
          throw new Error("Injected post-append live-state failure");
        setMessages(messages);
      },
    });
    f.responses.push(overflow());
    try {
      await f.session.prompt("Trigger native overflow");
      expect(f.events).toContainEqual(
        expect.objectContaining({
          type: "compaction_end",
          errorMessage: expect.stringContaining("Injected post-append live-state failure"),
        }),
      );
    } finally {
      Object.defineProperty(f.session.agent.state, "messages", descriptor);
    }
    const reopened = SessionManager.open(f.manager.getSessionFile()!);
    const checkpoint = reopened.getBranch().findLast((entry) => entry.type === "compaction");
    expect(checkpoint).toBeDefined();
    expect(f.manager.getLeafId()).toBe(checkpoint?.id);
    await f.session.prompt("Must remain stopped");
    expect(f.requests).toHaveLength(2);
  });
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "keeps ordinary prompts quarantined across resource reload after a real write failure",
    async () => {
      const f = await createSdkHarness([
        contextManagement,
        (pi) => {
          pi.on("tool_call", (event, ctx) => {
            if (event.toolName === "context_notes")
              chmodSync(ctx.sessionManager.getSessionFile()!, 0o400);
          });
        },
      ]);
      f.responses.push(
        toolCall("context_notes", { action: "write", name: "task", content: "unacknowledged" }),
      );
      try {
        await expect(f.session.prompt("Save a Note")).rejects.toThrow(/EACCES/);
      } finally {
        chmodSync(f.manager.getSessionFile()!, 0o600);
      }
      await f.session.reload();
      const before = JSON.stringify(f.manager.getEntries());
      f.responses.push(reply("Must not be requested."));
      await f.session.prompt("Try continuing after resource reload");
      expect(f.requests).toHaveLength(1);
      expect(JSON.stringify(f.manager.getEntries())).toBe(before);
    },
  );
  it("requests agent checkpointing through /rollover rather than committing in the command", async () => {
    const f = await createSdkHarness([contextManagement]);
    f.responses.push(
      toolCall("context_rollover", { handoff: "Continue the current task." }),
      reply("Continued."),
    );
    await f.session.prompt("/rollover preserve the pending decision");
    await expect.poll(() => f.requests.length).toBe(2);
    await f.session.waitForIdle();
    expect(f.requests).toHaveLength(2);
    expect(JSON.stringify(f.requests[0]).includes("Prepare a Context Rollover")).toBe(true);
    expect(f.manager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(1);
  });

  it.each(["tui", "sdk", "rpc"] as const)(
    "prepares fresh Notes and a Handoff before manual compaction in %s",
    async (mode) => {
      const f = await createSdkHarness([contextManagement]);
      await f.session.bindExtensions({ mode: mode === "sdk" ? "print" : mode });
      f.responses.push(reply("Ready."));
      await f.session.prompt("Original task " + "history ".repeat(3000));
      f.responses.push(
        toolCall("context_notes", {
          action: "write",
          name: "task",
          content: "Pending decision preserved.",
        }),
        toolCall("context_rollover", { handoff: "Fresh Handoff: resolve the pending decision." }),
        reply("Continued with the pending decision."),
      );
      await expect(f.session.compact("preserve the pending decision")).rejects.toThrow(
        "Compaction cancelled",
      );
      await expect.poll(() => f.requests.length).toBe(4);
      await f.session.waitForIdle();
      expect(JSON.stringify(f.requests[1])).toContain("Prepare a Context Rollover");
      expect(JSON.stringify(f.requests[1])).toContain(
        "Additional instructions: preserve the pending decision",
      );
      const checkpoints = f.manager.getBranch().filter((entry) => entry.type === "compaction");
      expect(checkpoints).toHaveLength(1);
      expect(checkpoints[0]?.summary).toContain("Fresh Handoff: resolve the pending decision.");
      expect(checkpoints[0]?.summary).not.toContain("saved Handoff may be stale");
      expect(f.providerRequests).toEqual([]);
      expect(f.session.messages).toEqual(f.manager.buildSessionContext().messages);
    },
  );

  it("keeps user-cancelled manual compaction stopped without disabling later prompts", async () => {
    let resumeHook: (() => void) | undefined;
    const f = await createSdkHarness([
      (pi) => {
        pi.on(
          "session_before_compact",
          () =>
            new Promise<void>((resolve) => {
              resumeHook = resolve;
            }),
        );
      },
      contextManagement,
    ]);
    await f.session.bindExtensions({ mode: "tui" });
    f.responses.push(reply("Ready."));
    await f.session.prompt("Original task " + "history ".repeat(3000));
    const compacting = expect(f.session.compact()).rejects.toThrow("Compaction cancelled");
    await expect.poll(() => resumeHook).toBeDefined();
    f.session.abortCompaction();
    resumeHook?.();
    await compacting;
    await f.session.waitForIdle();
    expect(f.requests).toHaveLength(1);
    expect(f.manager.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
    f.responses.push(reply("Continuing without compacting."));
    await f.session.prompt("Continue the original task");
    expect(f.requests).toHaveLength(2);
  });

  it("keeps acknowledged Notes when manual preparation is interrupted before its Handoff", async () => {
    const f = await createSdkHarness([
      contextManagement,
      (pi) => {
        pi.on("tool_result", (event, ctx) => {
          if (event.toolName === "context_notes" && event.input.action === "write") ctx.abort();
        });
      },
    ]);
    await f.session.bindExtensions({ mode: "tui" });
    f.responses.push(reply("Ready."));
    await f.session.prompt("Original task " + "history ".repeat(3000));
    f.responses.push(
      toolCall("context_notes", {
        action: "write",
        name: "task",
        content: "Keep this acknowledged decision.",
      }),
    );
    await expect(f.session.compact()).rejects.toThrow("Compaction cancelled");
    await expect.poll(() => f.requests.length).toBe(2);
    await f.session.waitForIdle();
    expect(f.manager.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
    f.responses.push(
      toolCall("context_notes", { action: "read", name: "task" }),
      reply("Decision recovered."),
    );
    await f.session.prompt("Read the saved task Note without rolling over");
    expect(JSON.stringify(f.requests.at(-1)?.messages.at(-1))).toContain(
      "Keep this acknowledged decision.",
    );
    expect(f.manager.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
    expect(f.providerRequests).toEqual([]);
  });

  it("leaves large live projections to native overflow rather than preflight fit guards", async () => {
    const f = await createSdkHarness(
      [
        contextManagement,
        (pi) => {
          pi.on("context", (event) => {
            if (!event.messages.some((message) => message.role === "compactionSummary")) return;
            return {
              messages: [
                ...event.messages,
                {
                  role: "custom",
                  customType: "large-live",
                  content: "LIVE ".repeat(20_000),
                  display: false,
                  timestamp: 0,
                },
              ],
            };
          });
        },
      ],
      { contextWindow: 16_000 },
    );
    f.responses.push(
      toolCall("context_rollover", { handoff: "Continue safely." }),
      reply("Provider accepted the projection."),
    );
    await f.session.prompt("Task");
    expect(f.requests).toHaveLength(2);
    expect(JSON.stringify(f.requests[1])).toContain("LIVE ".repeat(20_000));
    expect(f.manager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(1);
    expect(JSON.stringify(f.session.messages)).not.toContain("Fresh Context Window still exceeds");
  });

  it("does not estimate static instructions to block a native request", async () => {
    const f = await createSdkHarness([contextManagement], {
      contextWindow: 16_000,
      systemPrompt: "STANDING ".repeat(10_000),
    });
    f.responses.push(reply("Accepted."));
    await f.session.prompt("Task");
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]?.systemPrompt).toContain("STANDING ".repeat(10_000));
    expect(f.manager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(0);
  });

  it.each([
    { global: { tailTokens: -1 }, project: undefined, trusted: true, warnings: 1 },
    { global: undefined, project: "malformed", trusted: true, warnings: 1 },
    { global: null, project: false, trusted: true, warnings: 1 },
    { global: undefined, project: { tailTokens: -1 }, trusted: false, warnings: 0 },
    { global: undefined, project: undefined, trusted: true, warnings: 0 },
  ])(
    "ignores legacy settings without writes and warns once per load: %j",
    async ({ global, project, trusted, warnings }) => {
      let writes = 0;
      const settings = SettingsManager.fromStorage(
        {
          withLock(scope, fn) {
            const changed = fn(
              JSON.stringify({
                contextManagement: scope === "global" ? global : project,
                compaction: { enabled: true, reserveTokens: 1234, keepRecentTokens: 500 },
                retry: { enabled: false },
              }),
            );
            if (changed !== undefined) writes++;
          },
        },
        { projectTrusted: trusted },
      );
      const f = await createSdkHarness([contextManagement], { settings });
      const notices: string[] = [];
      await f.session.bindExtensions({
        mode: "rpc",
        uiContext: {
          ...f.session.extensionRunner.getUIContext(),
          notify: (message) => {
            notices.push(message);
          },
        },
      });
      notices.length = 0;
      for (let load = 1; load <= 2; load++) {
        await f.session.reload();
        f.responses.push(reply("Ready."));
        await f.session.prompt("Task");
        await f.session.prompt("/context");
        await f.session.prompt("/context");
        expect(notices.filter((message) => message.includes("obsolete and ignored"))).toHaveLength(
          load * warnings,
        );
        expect(notices.at(-1)).toContain("Native recent-history retention: 500 tokens.");
        expect(notices.at(-1)).toContain(
          `Native usage: ${f.session.getContextUsage()?.tokens} / 200000 tokens.`,
        );
      }
      expect(settings.getCompactionSettings()).toMatchObject({
        reserveTokens: 1234,
        keepRecentTokens: 500,
      });
      expect(writes).toBe(0);
      expect(f.requests).toHaveLength(2);
      expect(f.extensionErrors).toEqual([]);
    },
  );

  it("inspects without changing History or making a model request", async () => {
    const f = await createSdkHarness([contextManagement]);
    const before = JSON.stringify(f.manager.getEntries());
    await f.session.prompt("/context");
    expect(f.requests).toHaveLength(0);
    expect(JSON.stringify(f.manager.getEntries())).toBe(before);
  });
  it.each([512, 12_000, 24_000])(
    "does not add independent 80/90 percent warnings or checkpoints with output limit %i",
    async (maxTokens) => {
      const f = await createSdkHarness([contextManagement], { contextWindow: 24_000, maxTokens });
      f.responses.push(reply("Ready.", 8000));
      await f.session.prompt("Keep working");
      f.responses.push(reply("Still working.", 18_000));
      await f.session.prompt("Continue below the warning threshold");
      expect(f.requests).toHaveLength(2);
      expect(JSON.stringify(f.requests[1])).not.toContain("Context budget warning");
      expect(f.manager.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
      const next = toolCall("context_notes", { action: "list" });
      next.usage = reply("", 22_000).usage;
      f.responses.push(next, reply("Done."));
      await f.session.prompt("Continue");
      expect(f.requests).toHaveLength(4);
      expect(JSON.stringify(f.requests)).not.toContain("Context budget warning");
      expect(JSON.stringify(f.manager.getBranch()).includes("Context budget warning")).toBe(false);
      expect(f.manager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(0);
    },
  );
  it.each([150_000, 180_000])(
    "does not double-count large standing instructions after %i native input tokens",
    async (inputTokens) => {
      const f = await createSdkHarness([contextManagement], {
        systemPrompt: "S".repeat(90_000),
        contextSettings: { tailTokens: 0, safetyMarginTokens: 2000 },
      });
      f.responses.push(reply("Ready", inputTokens), reply("Continued"));
      await f.session.prompt("ORIGINAL-TASK");
      expect(f.manager.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
      await f.session.prompt("Continue");
      expect(f.requests).toHaveLength(2);
      expect(JSON.stringify(f.requests)).not.toContain("Context budget warning");
      expect(f.manager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(0);
      expect(JSON.stringify(f.requests[1])).toContain("ORIGINAL-TASK");
      expect(JSON.stringify(f.manager.getBranch())).toContain("ORIGINAL-TASK");
      expect(f.session.messages).toEqual(f.manager.buildSessionContext().messages);
      expect(f.providerRequests).toEqual([]);
      expect(f.extensionErrors).toEqual([]);
    },
  );

  it("recovers after native overflow without replaying the completed tool or its large result", async () => {
    let executions = 0;
    const f = await createSdkHarness(
      [
        (pi) => {
          pi.registerTool({
            name: "large_output",
            label: "Large",
            description: "Read fixture data",
            parameters: Type.Object({}),
            async execute() {
              executions++;
              return {
                content: [{ type: "text", text: "DATA-ONLY " + "data ".repeat(10_000) }],
                details: {},
              };
            },
          });
        },
        contextManagement,
      ],
      { contextWindow: 16_000, maxTokens: 16_000 },
    );
    f.responses.push(toolCall("large_output", {}), overflow(), reply("Recovered from History."));
    await f.session.prompt("Process the data");
    expect(executions).toBe(1);
    expect(f.requests).toHaveLength(3);
    expect(JSON.stringify(f.requests[1])).toContain("DATA-ONLY");
    expect(JSON.stringify(f.requests[2])).not.toContain("DATA-ONLY");
    expect(JSON.stringify(f.requests[2])).toContain("saved Handoff may be stale or absent");
    expect(f.manager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(1);
    expect(JSON.stringify(f.manager.getBranch())).toContain("DATA-ONLY");
  });
  it("enforces the Handoff schema limit rather than estimating its token fit", async () => {
    const f = await createSdkHarness([contextManagement], { contextWindow: 16_000 });
    f.responses.push(
      toolCall("context_rollover", { handoff: "X".repeat(64_001) }),
      reply("Will prepare a shorter Handoff."),
    );
    await f.session.prompt("Small task");
    expect(
      f.manager
        .getBranch()
        .some((entry) => entry.type === "custom" && entry.customType === "pi-context-handoff"),
    ).toBe(false);
    expect(f.manager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(0);
    expect(f.requests[1]?.messages.at(-1)).toMatchObject({ role: "toolResult", isError: true });
  });
  it("commits an agent Handoff mid-loop and resumes the same native Context Window", async () => {
    const f = await createSdkHarness([contextManagement], { keepRecentTokens: 500 });
    f.responses.push(reply("Ready."));
    await f.session.prompt("OLD-ONLY " + "discard ".repeat(12_000));
    f.responses.push(
      toolCall("context_rollover", { handoff: "Continue checking the blue widget." }),
      reply("Finished."),
    );
    await f.session.prompt("Continue with recent work " + "recent ".repeat(400));
    const checkpoint = f.manager.getBranch().findLast((entry) => entry.type === "compaction");
    expect(checkpoint, JSON.stringify(f.session.messages).slice(-2500)).toBeDefined();
    expect(checkpoint?.summary).toContain("Continue checking the blue widget.");
    expect(f.requests).toHaveLength(3);
    expect(JSON.stringify(f.requests[2])).not.toContain("OLD-ONLY");
    expect(f.session.messages).toEqual(f.manager.buildSessionContext().messages);
    const reopened = SessionManager.open(f.manager.getSessionFile()!);
    expect(JSON.stringify(reopened.buildSessionContext())).toBe(
      JSON.stringify(f.manager.buildSessionContext()),
    );
    expect(f.requests[2]?.tools).toContain("context_history");
    expect(f.requests[2]?.systemPrompt).toContain("Standing instructions");
  });
});
