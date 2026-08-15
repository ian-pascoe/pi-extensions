import { describe, expect, it, vi } from "vitest";
import type { MinimalSubagentsModelRole } from "../src/minimal-subagents-config.js";
import { createCoordinatorToolSchemas } from "../src/minimal-subagents-tool-schemas.js";
import { createCoordinatorToolDefinitions } from "../src/minimal-subagents-tools.js";

function toolOptions(
  callerId: string,
  allowFanoutTools?: boolean,
  modelRoles: readonly MinimalSubagentsModelRole[] = [],
) {
  return {
    coordinator: {
      spawn: vi.fn(),
      inspectStatus: vi.fn(() => ({ agents: [] })),
      sendAgentMessage: vi.fn(),
      wait: vi.fn(),
      status: vi.fn(() => ({ parent_id: callerId, agents: [] })),
      cancel: vi.fn(),
      delete: vi.fn(),
    },
    callerId,
    allowFanoutTools,
    modelRoles,
    schemas: createCoordinatorToolSchemas(["provider/model"]),
    captureCaller: vi.fn(),
  };
}

describe("minimal subagents coordinator tools", () => {
  it("explains that named tool profiles and exact tool arrays are different", () => {
    const schema = createCoordinatorToolSchemas(["provider/model"]);
    const tools = schema.subagent.properties?.tools as {
      description?: string;
      anyOf?: Array<{ description?: string }>;
    };
    expect(tools.description).toContain('Use the string preset "read"');
    expect(tools.description).toContain("An array grants exactly those named tools");
    expect(
      tools.anyOf?.some((branch) => branch.description?.includes("Exact ordinary tool names")),
    ).toBe(true);
  });

  it("gives root and explicit fanout callers all six coordinator tools", () => {
    const expected = [
      "subagent",
      "agent_message",
      "subagent_wait",
      "subagent_status",
      "subagent_cancel",
      "subagent_delete",
    ];
    expect(
      createCoordinatorToolDefinitions(toolOptions("root") as never).map(({ name }) => name),
    ).toEqual(expected);
    expect(
      createCoordinatorToolDefinitions(toolOptions("child", true) as never).map(({ name }) => name),
    ).toEqual(expected);
  });

  it("gives ordinary children only the three adjacent-coordination tools", () => {
    expect(
      createCoordinatorToolDefinitions(toolOptions("child", false) as never).map(
        ({ name }) => name,
      ),
    ).toEqual(["agent_message", "subagent_wait", "subagent_status"]);
  });

  it("forwards an exact retained turn ID through subagent_wait", async () => {
    const options = toolOptions("root", true);
    options.coordinator.wait.mockResolvedValue({
      event: "turn",
      agent_id: "child",
      turn_id: "child:older",
      status: "completed",
      output: "older",
    });
    const waitTool = createCoordinatorToolDefinitions(options as never).find(
      ({ name }) => name === "subagent_wait",
    )!;
    const signal = new AbortController().signal;

    await waitTool.execute(
      "call",
      { agent_id: "child", turn_id: "child:older", timeout_ms: 50 },
      signal,
      undefined,
      {} as never,
    );

    expect(options.coordinator.wait).toHaveBeenCalledWith(
      "root",
      "child",
      50,
      signal,
      "child:older",
    );
  });

  it("guides callers with separate advisory model and thinking_level arguments", () => {
    const subagentTool = createCoordinatorToolDefinitions(
      toolOptions("root", true, [
        { name: "budget", model: "opencode-go/glm-5.2", thinkingLevel: "low" },
        {
          name: "design",
          model: "opencode-go/kimi-k3",
          thinkingLevel: "high",
          hint: "UI design, visual critique, and frontend polish",
        },
        { name: "general", model: "provider/model" },
      ]) as never,
    ).find(({ name }) => name === "subagent");
    const promptGuidelines = subagentTool?.promptGuidelines?.join("\n") ?? "";

    expect(promptGuidelines).toContain("budget → model=opencode-go/glm-5.2, thinking_level=low");
    expect(promptGuidelines).toContain(
      "design → model=opencode-go/kimi-k3, thinking_level=high — UI design, visual critique, and frontend polish",
    );
    expect(promptGuidelines).toContain("general → model=provider/model");
    expect(promptGuidelines).not.toContain("opencode-go/glm-5.2:low");
    expect(promptGuidelines).not.toContain("opencode-go/kimi-k3:high");
    expect(promptGuidelines).toContain("A listed thinking_level is a preference, not a constraint");
    expect(promptGuidelines).toContain(
      "Callers choose thinking_level independently for roles without one.",
    );
  });

  it("adds no role-specific prompt guidance for an empty role list", () => {
    const subagentTool = createCoordinatorToolDefinitions(
      toolOptions("root", true, []) as never,
    ).find(({ name }) => name === "subagent");

    expect(subagentTool?.promptGuidelines).toBeUndefined();
  });
});
