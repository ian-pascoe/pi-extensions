import { describe, expect, it } from "vitest";
import {
  buildEligibleModelIds,
  canAgentContractSpawn,
  excludeCoordinatorTools,
  getSubagentDepth,
  resolveOrdinaryToolSelection,
  stripThinkingSuffix,
} from "../src/minimal-subagents-capabilities.js";

describe("minimal subagent capabilities", () => {
  it("derives unique eligible models from the configured scope and removes thinking suffixes", () => {
    expect(stripThinkingSuffix("openai/gpt:xhigh")).toBe("openai/gpt");
    expect(stripThinkingSuffix("provider/model:preview")).toBe("provider/model:preview");
    expect(
      buildEligibleModelIds({
        availableModels: [{ provider: "fallback", id: "model" }],
        scopedModels: [
          { model: { provider: "openai", id: "gpt:xhigh" } },
          { model: { provider: "openai", id: "gpt:xhigh" } },
        ],
        scopeConfigured: true,
      }),
    ).toEqual(["openai/gpt"]);
  });

  it("enforces exact tool availability and the inherited capability ceiling", () => {
    const context = {
      ordinaryTools: ["read", "write"],
      capabilityCeiling: ["read", "grep", "find", "ls"],
      availableTools: ["read", "grep", "find", "ls", "write"],
    };
    expect(resolveOrdinaryToolSelection("read", context)).toEqual(["read", "grep", "find", "ls"]);
    expect(() => resolveOrdinaryToolSelection(["missing"], context)).toThrow(
      "Minimal subagents tool resolution: unavailable tool: missing",
    );
    expect(() => resolveOrdinaryToolSelection(["write"], context)).toThrow(
      "Minimal subagents capability ceiling exceeded: write",
    );
  });

  it("bounds fanout by hierarchy depth and strips all coordinator tools", () => {
    expect(getSubagentDepth("root")).toBe(0);
    expect(getSubagentDepth("child.grandchild")).toBe(2);
    expect(getSubagentDepth("root.child.grandchild")).toBe(2);
    expect(canAgentContractSpawn("child", "fanout", 2)).toBe(true);
    expect(canAgentContractSpawn("child.grandchild", "fanout", 2)).toBe(false);
    expect(canAgentContractSpawn("child", "none", 2)).toBe(false);
    expect(
      excludeCoordinatorTools(["read", "subagent", "agent_message", "subagent_delete"]),
    ).toEqual(["read"]);
  });
});
