import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
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

describe("Context budget provenance feasibility through the Pi SDK", () => {
  it("retains conservative double counting until request provenance is proven", async () => {
    const f = await createSdkHarness([], { systemPrompt: "S".repeat(90_000) });
    f.responses.push(reply("Ready", 150_000));
    await f.session.prompt("Start");
    const budget = contextBudget(f.session, {
      ...resolveContextSettings(f.settings),
      safetyMarginTokens: 2000,
    });
    expect(budget.measuredTokens).toBe(150_010);
    expect(budget.staticTokens).toBeGreaterThanOrEqual(30_000);
    expect(budget.inputTokens).toBe(152_010 + budget.staticTokens);
    expect(budget.ratio).toBeGreaterThanOrEqual(0.9);
    // A complete usage estimate plus margin would be 152,010 (<80%), but only
    // proven unchanged outgoing standing context may authorize that reduction.
    expect(152_010 / budget.contextWindow).toBeLessThan(0.8);
    expect(f.providerRequests).toEqual([]);
    expect(f.extensionErrors).toEqual([]);
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
