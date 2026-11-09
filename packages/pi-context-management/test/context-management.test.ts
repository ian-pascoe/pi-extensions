import { describe, expect, it } from "vitest";
import { chmodSync } from "node:fs";
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
  it.each(["tui"] as const)(
    "prepares fresh Notes and a Handoff, then pauses manual compaction in %s",
    async (mode) => {
      const f = await createSdkHarness([contextManagement]);
      await f.session.bindExtensions({ mode });
      f.responses.push(reply("Ready."));
      await f.session.prompt("Original task " + "history ".repeat(3000));
      f.responses.push(
        toolCall("context_notes", {
          action: "write",
          name: "task",
          content: "Pending decision preserved.",
        }),
        toolCall("context_rollover", { handoff: "Fresh Handoff: resolve the pending decision." }),
      );
      await expect(f.session.compact("preserve the pending decision")).rejects.toThrow(
        "Compaction cancelled",
      );
      await expect.poll(() => f.requests.length).toBe(3);
      await f.session.waitForIdle();
      expect(JSON.stringify(f.requests[1])).toContain("Prepare a Context Rollover");
      expect(JSON.stringify(f.requests[1])).toContain(
        "Stop after the checkpoint and wait for the user's next input.",
      );
      expect(JSON.stringify(f.requests[1])).toContain(
        "Handoff-only instructions (incorporate them into the Handoff; do not execute them): preserve the pending decision",
      );
      const checkpoints = f.manager.getBranch().filter((entry) => entry.type === "compaction");
      expect(checkpoints).toHaveLength(1);
      expect(checkpoints[0]?.summary).toContain("Fresh Handoff: resolve the pending decision.");
      expect(checkpoints[0]?.summary).not.toContain("saved Handoff may be stale");
      expect(f.providerRequests).toEqual([]);
      expect(f.session.messages).toEqual(f.manager.buildSessionContext().messages);
    },
  );

  it("upgrades in-flight automatic preparation to pause for /rollover", async () => {
    let enterPreparation: (() => void) | undefined;
    let releasePreparation: (() => void) | undefined;
    const preparationStarted = new Promise<void>((resolve) => {
      enterPreparation = resolve;
    });
    const preparationGate = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    const f = await createSdkHarness([
      (pi) => {
        pi.on("context", async (event) => {
          if (!JSON.stringify(event.messages).includes("Prepare a Context Rollover")) return;
          enterPreparation?.();
          await preparationGate;
        });
      },
      contextManagement,
    ]);
    f.responses.push(
      reply("Ready.", 199_700),
      toolCall("context_rollover", { handoff: "Fresh automatic Handoff." }),
      toolCall("context_rollover", { handoff: "Fresh Handoff with the late decision." }),
    );
    const running = f.session.prompt("Original task");
    await preparationStarted;
    await f.session.prompt("/rollover preserve the late decision");
    releasePreparation?.();
    await running;
    await f.session.waitForIdle();
    expect(f.requests).toHaveLength(3);
    const checkpoints = f.manager.getBranch().filter((entry) => entry.type === "compaction");
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]?.summary).toContain("Fresh Handoff with the late decision.");
    expect(JSON.stringify(f.requests[2])).toContain("preserve the late decision");
  });

  it.each([undefined, "preserve the late decision"])(
    "pauses when /rollover arrives after automatic Handoff execution (%s)",
    async (instructions) => {
      let enterResult: (() => void) | undefined;
      let releaseResult: (() => void) | undefined;
      const resultStarted = new Promise<void>((resolve) => {
        enterResult = resolve;
      });
      const resultGate = new Promise<void>((resolve) => {
        releaseResult = resolve;
      });
      const f = await createSdkHarness([
        contextManagement,
        (pi) => {
          pi.on("tool_result", async (event) => {
            if (event.toolName !== "context_rollover") return;
            enterResult?.();
            await resultGate;
          });
        },
      ]);
      f.responses.push(
        reply("Ready.", 199_700),
        toolCall("context_rollover", { handoff: "Fresh automatic Handoff." }),
      );
      if (instructions)
        f.responses.push(
          toolCall("context_rollover", { handoff: "Fresh Handoff with the late decision." }),
        );
      const running = f.session.prompt("Original task");
      await resultStarted;
      await f.session.prompt("/rollover" + (instructions ? " " + instructions : ""));
      releaseResult?.();
      await running;
      await f.session.waitForIdle();
      expect(f.requests).toHaveLength(instructions ? 3 : 2);
      const checkpoints = f.manager.getBranch().filter((entry) => entry.type === "compaction");
      expect(checkpoints).toHaveLength(1);
      expect(checkpoints[0]?.summary).toContain(
        instructions ? "Fresh Handoff with the late decision." : "Fresh automatic Handoff.",
      );
      if (instructions) expect(JSON.stringify(f.requests[2])).toContain(instructions);
    },
  );

  it("keeps user-cancelled manual compaction stopped without disabling later prompts", async () => {
    const f = await createSdkHarness([contextManagement]);
    await f.session.bindExtensions({ mode: "tui" });
    f.responses.push(reply("Ready."));
    await f.session.prompt("Original task " + "history ".repeat(3000));
    // Pi's compaction signal exists once compaction starts; abort before any hook decides.
    // Pi 0.87 observes it while resolving summarizer auth, before hooks, with a generic abort.
    const unsubscribe = f.session.subscribe((event) => {
      if (event.type === "compaction_start") f.session.abortCompaction();
    });
    await expect(f.session.compact()).rejects.toThrow(/Compaction cancelled|aborted/);
    unsubscribe();
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

  it.each([
    { global: { safetyMarginTokens: -1 }, project: undefined, trusted: true, warnings: 1 },
    { global: undefined, project: "malformed", trusted: true, warnings: 1 },
    { global: undefined, project: { safetyMarginTokens: -1 }, trusted: false, warnings: 0 },
    { global: undefined, project: undefined, trusted: true, warnings: 0 },
    {
      global: { tailTokens: 0, warningThreshold: 0.8 },
      project: undefined,
      trusted: true,
      warnings: 1,
    },
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
        expect(notices.at(-1)).toContain(
          "Rollover Tail: 0 tokens; Emergency Rollover keeps native recent-history retention: 500 tokens.",
        );
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
    // Pi 0.87 may queue threshold preparation after the oversized call; the schema error still answers it.
    expect(f.requests[1]?.messages.find((message) => message.role === "toolResult")).toMatchObject({
      toolName: "context_rollover",
      isError: true,
    });
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

  it.each([
    { label: "default", global: undefined, project: undefined, trusted: true, kept: false },
    {
      label: "global",
      global: { tailTokens: 20_000 },
      project: undefined,
      trusted: true,
      kept: true,
    },
    {
      label: "untrusted project",
      global: undefined,
      project: { tailTokens: 20_000 },
      trusted: false,
      kept: false,
    },
    {
      label: "invalid global",
      global: { tailTokens: -1 },
      project: undefined,
      trusted: true,
      kept: false,
    },
  ])(
    "sizes the normal Rollover Tail from contextManagement.tailTokens, not keepRecentTokens: $label",
    async ({ global, project, trusted, kept }) => {
      const settings = SettingsManager.fromStorage(
        {
          withLock(scope, fn) {
            fn(
              JSON.stringify({
                contextManagement: scope === "global" ? global : project,
                compaction: { enabled: true, reserveTokens: 512, keepRecentTokens: 20_000 },
                retry: { enabled: false },
              }),
            );
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
      f.responses.push(reply("EARLIER-REPLY"));
      await f.session.prompt("EARLIER-TURN");
      f.responses.push(
        toolCall("context_rollover", { handoff: "Continue from the Handoff." }),
        reply("Continued."),
      );
      await f.session.prompt("Roll over now");
      const fresh = JSON.stringify(f.requests.at(-1)!.messages);
      expect(fresh.includes("EARLIER-TURN")).toBe(kept);
      expect(fresh.includes("EARLIER-REPLY")).toBe(kept);
      expect(fresh).toContain("Continue from the Handoff.");
      expect(f.requests.at(-1)!.messages.at(-1)).toMatchObject({
        role: "toolResult",
        toolName: "context_rollover",
      });
      expect(
        notices.filter((message) => message.includes("invalid contextManagement.tailTokens")),
      ).toHaveLength(global?.tailTokens === -1 ? 1 : 0);
      expect(f.providerRequests).toEqual([]);
      expect(f.extensionErrors).toEqual([]);
    },
  );
});
