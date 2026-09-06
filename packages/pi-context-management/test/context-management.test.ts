import { describe, expect, it } from "vitest";
import { chmodSync } from "node:fs";
import { Type } from "typebox";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import contextManagement from "../src/context-management-extension.js";
import { createSdkHarness, reply, toolCall } from "./sdk-harness.js";

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
    try {
      await expect(f.session.compact()).rejects.toThrow("Injected post-append live-state failure");
    } finally {
      Object.defineProperty(f.session.agent.state, "messages", descriptor);
    }
    const reopened = SessionManager.open(f.manager.getSessionFile()!);
    const checkpoint = reopened.getBranch().findLast((entry) => entry.type === "compaction");
    expect(checkpoint).toBeDefined();
    expect(f.manager.getLeafId()).toBe(checkpoint?.id);
    await f.session.prompt("Must remain stopped");
    expect(f.requests).toHaveLength(1);
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

  it("does not repeatedly rebuild a fresh window that live projections make too large", async () => {
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
    f.responses.push(toolCall("context_rollover", { handoff: "Continue safely." }));
    await f.session.prompt("Task");
    expect(f.requests).toHaveLength(1);
    expect(f.manager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(1);
    expect(JSON.stringify(f.session.messages).includes("Fresh Context Window still exceeds")).toBe(
      true,
    );
  });

  it("stops before sending static instructions that consume the usable budget", async () => {
    const f = await createSdkHarness([contextManagement], {
      contextWindow: 16_000,
      systemPrompt: "STANDING ".repeat(10_000),
    });
    await f.session.prompt("Task");
    expect(f.requests).toHaveLength(0);
    expect(f.manager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(0);
  });

  for (const trusted of [false, true]) {
    it("applies project context settings only when trusted: " + trusted, async () => {
      const settings = SettingsManager.fromStorage(
        {
          withLock(scope, fn) {
            fn(
              JSON.stringify(
                scope === "global"
                  ? { contextManagement: { tailTokens: 0 } }
                  : { contextManagement: { tailTokens: -1 } },
              ),
            );
          },
        },
        { projectTrusted: trusted },
      );
      const f = await createSdkHarness([contextManagement], { settings });
      f.responses.push(reply("Ready."));
      await f.session.prompt("Task");
      expect(f.requests).toHaveLength(trusted ? 0 : 1);
    });
  }

  it("inspects without changing History or making a model request", async () => {
    const f = await createSdkHarness([contextManagement]);
    const before = JSON.stringify(f.manager.getEntries());
    await f.session.prompt("/context");
    expect(f.requests).toHaveLength(0);
    expect(JSON.stringify(f.manager.getEntries())).toBe(before);
  });
  it("warns once near 80% of usable input without persisting the reminder", async () => {
    const f = await createSdkHarness([contextManagement], { contextWindow: 24_000 });
    f.responses.push(reply("Ready.", 16_000));
    await f.session.prompt("Keep working");
    const next = toolCall("context_notes", { action: "list" });
    next.usage = reply("", 16_000).usage;
    f.responses.push(next, reply("Done."));
    await f.session.prompt("Continue");
    expect(
      JSON.stringify(f.requests[1]).includes("Context budget warning"),
      JSON.stringify({
        window: f.session.model?.contextWindow,
        checkpoints: f.manager.getBranch().filter((e) => e.type === "compaction").length,
        request: JSON.stringify(f.requests[1]).slice(-1500),
      }),
    ).toBe(true);
    expect(JSON.stringify(f.requests[2]).includes("Context budget warning")).toBe(false);
    expect(JSON.stringify(f.manager.getBranch()).includes("Context budget warning")).toBe(false);
    expect(f.manager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(0);
  });
  it("rolls over before sending a large tool result and never replays the completed tool", async () => {
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
                content: [{ type: "text", text: "DATA-ONLY " + "data ".repeat(9000) }],
                details: {},
              };
            },
          });
        },
        contextManagement,
      ],
      { contextWindow: 16_000 },
    );
    f.responses.push(toolCall("large_output", {}), reply("Recovered from History."));
    await f.session.prompt("Process the data");
    expect(executions).toBe(1);
    expect(f.requests).toHaveLength(2);
    expect(JSON.stringify(f.requests[1])).not.toContain("DATA-ONLY");
    expect(JSON.stringify(f.requests[1])).toContain("saved Handoff may be stale or absent");
    expect(f.manager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(1);
    expect(JSON.stringify(f.manager.getBranch())).toContain("DATA-ONLY");
  });
  it("refuses an oversized Handoff rather than saving or truncating it", async () => {
    const f = await createSdkHarness([contextManagement], { contextWindow: 16_000 });
    f.responses.push(
      toolCall("context_rollover", { handoff: "X".repeat(60_000) }),
      reply("Will prepare a shorter Handoff."),
    );
    await f.session.prompt("Small task");
    expect(
      f.manager
        .getBranch()
        .some((entry) => entry.type === "custom" && entry.customType === "pi-context-handoff"),
    ).toBe(false);
    expect(
      f.manager
        .getBranch()
        .filter((entry) => entry.type === "compaction")
        .every((entry) => !JSON.stringify(entry.details).includes('"reason":"normal"')),
    ).toBe(true);
  });
  it("commits an agent Handoff mid-loop and resumes the same native Context Window", async () => {
    const f = await createSdkHarness([contextManagement]);
    f.responses.push(
      toolCall("context_rollover", { handoff: "Continue checking the blue widget." }),
      reply("Finished."),
    );
    await f.session.prompt("OLD-ONLY " + "discard ".repeat(12_000));
    const checkpoint = f.manager.getBranch().findLast((entry) => entry.type === "compaction");
    expect(checkpoint, JSON.stringify(f.session.messages).slice(-2500)).toBeDefined();
    expect(checkpoint?.summary).toContain("Continue checking the blue widget.");
    expect(f.requests).toHaveLength(2);
    expect(JSON.stringify(f.requests[1])).not.toContain("OLD-ONLY");
    expect(f.session.messages).toEqual(f.manager.buildSessionContext().messages);
    const reopened = SessionManager.open(f.manager.getSessionFile()!);
    expect(JSON.stringify(reopened.buildSessionContext())).toBe(
      JSON.stringify(f.manager.buildSessionContext()),
    );
    expect(f.requests[1]?.tools).toContain("context_history");
    expect(f.requests[1]?.systemPrompt).toContain("Standing instructions");
  });
});
