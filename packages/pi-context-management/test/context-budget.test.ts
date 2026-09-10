import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import { estimateTokens, type AgentSession } from "@earendil-works/pi-coding-agent";
import contextManagement from "../src/context-management-extension.js";
import { captureCheckpointAdapter, type CheckpointAdapter } from "../src/checkpoint-adapter.js";
import { contextBudget } from "../src/context-window.js";
import { resolveContextSettings } from "../src/context-settings.js";
import { createSdkHarness, reply } from "./sdk-harness.js";

function standing(session: AgentSession) {
  return {
    systemPrompt: session.agent.state.systemPrompt,
    tools: session.agent.state.tools.map(({ name, description, parameters }) => ({
      name,
      description,
      parameters: structuredClone(parameters),
    })),
    model: {
      api: session.model?.api,
      provider: session.model?.provider,
      id: session.model?.id,
    },
  };
}

describe("Context budget estimates through the Pi SDK", () => {
  it("counts standing context once when Pi's complete usage dominates", async () => {
    const f = await createSdkHarness([], { systemPrompt: "S".repeat(90_000) });
    f.responses.push(reply("Ready", 150_000));
    await f.session.prompt("Start");
    const budget = contextBudget(f.session, {
      ...resolveContextSettings(f.settings),
      safetyMarginTokens: 2000,
    });
    expect(budget.measuredTokens).toBe(150_010);
    expect(budget.staticTokens).toBeGreaterThanOrEqual(30_000);
    expect(budget.inputTokens).toBe(152_010);
    expect(budget.ratio).toBeLessThan(0.8);
    expect(
      (budget.inputTokens + budget.staticTokens) / budget.contextWindow,
    ).toBeGreaterThanOrEqual(0.9);
    expect(f.providerRequests).toEqual([]);
    expect(f.extensionErrors).toEqual([]);
  });

  it.each(["zero", "error", "aborted"] as const)(
    "estimates current content before valid usage and after a %s response",
    async (reason) => {
      const f = await createSdkHarness([], { systemPrompt: "S".repeat(3000) });
      const settings = { ...resolveContextSettings(f.settings), safetyMarginTokens: 2000 };
      const initial = contextBudget(f.session, settings);
      expect(initial.inputTokens).toBe(initial.staticTokens + 2000);
      const response = reply("Ready", 150_000);
      if (reason === "zero") {
        response.usage.input = 0;
        response.usage.output = 0;
        response.usage.totalTokens = 0;
      } else response.stopReason = reason;
      f.responses.push(response);
      await f.session.prompt("12345678");
      const budget = contextBudget(f.session, settings);
      expect(budget.measuredTokens).toBe(4);
      expect(budget.inputTokens).toBe(budget.staticTokens + 2004);
    },
  );

  it.each([155_000, 0])(
    "counts complete usage, persisted trailing content, and only positive live growth (totalTokens=%i)",
    async (totalTokens) => {
      const f = await createSdkHarness([]);
      const response = reply("Ready");
      response.usage = {
        ...response.usage,
        input: 100_000,
        output: 10_000,
        cacheRead: 30_000,
        cacheWrite: 10_000,
        totalTokens,
      };
      f.responses.push(response);
      await f.session.prompt("Start");
      await f.session.sendCustomMessage({
        customType: "trailing",
        content: "trail".repeat(4),
        display: false,
      });
      expect(f.manager.getLeafEntry()).toMatchObject({ type: "custom_message" });
      const settings = { ...resolveContextSettings(f.settings), safetyMarginTokens: 2000 };
      const expectedUsage = totalTokens || 150_000;
      const budget = contextBudget(f.session, settings);
      expect(budget.measuredTokens).toBe(expectedUsage + 5);
      expect(budget.inputTokens).toBe(expectedUsage + 2005);
      const grown = contextBudget(f.session, settings, [
        ...f.session.messages,
        { role: "user", content: "X".repeat(40), timestamp: 0 },
      ]);
      expect(grown.inputTokens).toBe(expectedUsage + 2015);
      expect(contextBudget(f.session, settings, []).inputTokens).toBe(expectedUsage + 2005);
      expect(f.requests).toHaveLength(1);
    },
  );

  it("estimates the fresh Context Window after a native checkpoint until new usage arrives", async () => {
    const f = await createSdkHarness([contextManagement], {
      systemPrompt: "S".repeat(90_000),
      contextSettings: { tailTokens: 0, safetyMarginTokens: 2000 },
    });
    f.responses.push(reply("Ready", 150_000));
    await f.session.prompt("Original task " + "history ".repeat(2000));
    await f.session.compact();
    expect(f.session.getContextUsage()?.tokens).toBeNull();
    const settings = resolveContextSettings(f.settings);
    const budget = contextBudget(f.session, settings);
    const freshMessages = f.session.messages.reduce(
      (sum, message) => sum + estimateTokens(message),
      0,
    );
    expect(budget.measuredTokens).toBeNull();
    expect(budget.staticTokens).toBeGreaterThanOrEqual(30_000);
    expect(budget.inputTokens).toBe(budget.staticTokens + freshMessages + 2000);
    expect(budget.inputTokens).toBeLessThan(100_000);
    f.responses.push(reply("Continuing", 100_000));
    await f.session.prompt("Continue");
    expect(contextBudget(f.session, settings).inputTokens).toBe(102_010);
    expect(f.manager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(1);
    expect(f.providerRequests).toEqual([]);
    expect(f.extensionErrors).toEqual([]);
  });

  it("recomputes standing estimates without promising to detect growth below older usage", async () => {
    const f = await createSdkHarness([contextManagement], {
      systemPrompt: "S".repeat(120_000),
      contextSettings: { safetyMarginTokens: 2000 },
    });
    f.responses.push(reply("Ready", 170_000));
    await f.session.prompt("H".repeat(160_000));
    const settings = resolveContextSettings(f.settings);
    const initial = contextBudget(f.session, settings);
    f.session.agent.state.systemPrompt += "G".repeat(120_000);
    const grown = contextBudget(f.session, settings);
    expect(grown.staticTokens - initial.staticTokens).toBe(40_000);
    // Accepted approximation: the larger complete estimate can hide new growth.
    expect(grown.inputTokens).toBe(172_010);
    f.session.agent.state.tools = f.session.agent.state.tools.map((tool, index) =>
      index === 0
        ? {
            ...tool,
            description: "D".repeat(180_000),
            parameters: Type.Object({ value: Type.String({ description: "P".repeat(120_000) }) }),
          }
        : tool,
    );
    const larger = contextBudget(f.session, settings);
    expect(larger.staticTokens).toBeGreaterThan(grown.staticTokens + 90_000);
    expect(larger.inputTokens).toBe(larger.staticTokens + 42_002);
    expect(larger.ratio).toBeGreaterThan(0.9);
    expect(f.requests).toHaveLength(1);
  });

  it("cannot prove unchanged outgoing standing context from the budget hook's state", async () => {
    let adapter: CheckpointAdapter;
    const observations: ReturnType<typeof standing>[] = [];
    const budgets: ReturnType<typeof contextBudget>[] = [];
    const f = await createSdkHarness([
      (pi) => {
        pi.on("session_start", () => {
          adapter = captureCheckpointAdapter(pi, {
            afterTransformContext() {
              observations.push(standing(adapter.session));
              budgets.push(
                contextBudget(adapter.session, {
                  ...resolveContextSettings(adapter.session.settingsManager),
                  safetyMarginTokens: 2000,
                }),
              );
            },
          });
        });
        pi.on("session_shutdown", () => adapter.dispose());
      },
      (pi) => {
        for (const name of ["small", "large"]) {
          pi.registerTool({
            name,
            label: name,
            description: name === "large" ? "L".repeat(120_000) : "Small tool",
            parameters: Type.Object({}),
            async execute() {
              return { content: [{ type: "text", text: "Done" }], details: {} };
            },
          });
        }
        pi.on("session_start", () => pi.setActiveTools(["small"]));
        pi.on("before_agent_start", (event) => ({
          systemPrompt: event.systemPrompt + "\nFinal chained instructions.",
        }));
        pi.on("context", () => pi.setActiveTools(["small"]));
      },
    ]);
    f.responses.push(reply("First", 170_000), reply("Second", 170_000));
    await f.session.prompt("Start");
    f.session.setActiveToolsByName(["small", "large"]);
    await f.session.prompt("Continue");
    expect(f.requests).toHaveLength(2);
    expect(observations).toHaveLength(2);
    expect(observations[0]?.systemPrompt).toContain("Final chained instructions.");
    expect(observations[0]?.systemPrompt).toBe(f.requests[0]?.systemPrompt);
    expect(observations[0]?.tools).toEqual(f.requests[0]?.toolDefinitions);
    expect(observations[0]).toEqual(observations[1]);
    expect(f.requests[0]?.tools).toEqual(["small"]);
    // Pi snapshots standing context before context hooks. Even correctly paired
    // prior usage cannot prove that the next request uses this unchanged state.
    expect(f.requests[1]?.tools).toEqual(["small", "large"]);
    expect(f.requests[1]?.toolDefinitions?.[1]?.description).toHaveLength(120_000);
    expect(observations[1]?.tools).not.toEqual(f.requests[1]?.toolDefinitions);
    expect(budgets[1]?.measuredTokens).toBeGreaterThanOrEqual(170_010);
    expect(budgets[1]?.staticTokens).toBeLessThan(1000);
    expect(budgets[1]?.ratio).toBeLessThan(0.9);
    expect(f.providerRequests).toEqual([]);
    expect(f.extensionErrors).toEqual([]);
  });
});
