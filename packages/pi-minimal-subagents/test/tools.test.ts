import { describe, expect, it, vi } from "vitest";
import type { MinimalSubagentsModelRole } from "../src/minimal-subagents-config.js";
import { createCoordinatorToolSchemas } from "../src/minimal-subagents-tool-schemas.js";
import {
  createCoordinatorToolDefinitions,
  executeCoordinatorWaitTool,
  type CoordinatorToolDefinitionOptions,
  type CoordinatorToolOperations,
} from "../src/minimal-subagents-tools.js";

type RecordingWait = ReturnType<typeof vi.fn<CoordinatorToolOperations["wait"]>>;

interface RecordingToolOptions extends CoordinatorToolDefinitionOptions {
  readonly recordedWait: RecordingWait;
}

function toolOptions(
  callerId: string,
  allowFanoutTools?: boolean,
  modelRoles: readonly MinimalSubagentsModelRole[] = [],
): RecordingToolOptions {
  const recordedWait = vi.fn<CoordinatorToolOperations["wait"]>();
  const coordinator = {
    spawn: vi.fn<CoordinatorToolOperations["spawn"]>(),
    inspectStatus: vi.fn<CoordinatorToolOperations["inspectStatus"]>(() => ({
      root_id: "root",
      agents: [],
    })),
    sendAgentMessage: vi.fn<CoordinatorToolOperations["sendAgentMessage"]>(),
    wait: recordedWait,
    status: vi.fn<CoordinatorToolOperations["status"]>(() => ({ parent_id: callerId, agents: [] })),
    cancel: vi.fn<CoordinatorToolOperations["cancel"]>(),
    delete: vi.fn<CoordinatorToolOperations["delete"]>(),
  } satisfies CoordinatorToolOperations;
  const options: CoordinatorToolDefinitionOptions = {
    coordinator,
    callerId,
    modelRoles,
    schemas: createCoordinatorToolSchemas(["provider/model"]),
    captureCaller: vi.fn<CoordinatorToolDefinitionOptions["captureCaller"]>(),
  };
  if (allowFanoutTools !== undefined) options.allowFanoutTools = allowFanoutTools;
  return { ...options, recordedWait };
}

function requireTool(
  options: CoordinatorToolDefinitionOptions,
  toolName: string,
): ReturnType<typeof createCoordinatorToolDefinitions>[number] {
  const tool = createCoordinatorToolDefinitions(options).find(({ name }) => name === toolName);
  if (tool === undefined) throw new Error(`Expected coordinator tool definition: ${toolName}`);
  return tool;
}

describe("minimal subagents coordinator tools", () => {
  it("explains that named tool profiles and exact tool arrays are different", () => {
    const schema = createCoordinatorToolSchemas(["provider/model"]);
    const tools = schema.subagent.properties.tools;
    const serializedToolsSchema = JSON.stringify(tools);
    expect(serializedToolsSchema).toContain('Use the string preset \\"read\\"');
    expect(serializedToolsSchema).toContain("An array grants exactly those named tools");
    expect(serializedToolsSchema).toContain("Exact ordinary tool names");
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
    expect(createCoordinatorToolDefinitions(toolOptions("root")).map(({ name }) => name)).toEqual(
      expected,
    );
    expect(
      createCoordinatorToolDefinitions(toolOptions("child", true)).map(({ name }) => name),
    ).toEqual(expected);
  });

  it("gives ordinary children only the three adjacent-coordination tools", () => {
    expect(
      createCoordinatorToolDefinitions(toolOptions("child", false)).map(({ name }) => name),
    ).toEqual(["agent_message", "subagent_wait", "subagent_status"]);
  });

  it("forwards an exact retained turn ID through subagent_wait", async () => {
    const options = toolOptions("root", true);
    options.recordedWait.mockResolvedValue({
      event: "turn",
      agent_id: "child",
      turn_id: "child:older",
      status: "completed",
      output: "older",
    });
    const signal = new AbortController().signal;

    await executeCoordinatorWaitTool(
      options.coordinator,
      "root",
      { agent_id: "child", turn_id: "child:older", timeout_ms: 50 },
      signal,
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
      ]),
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
    const subagentTool = requireTool(toolOptions("root", true, []), "subagent");

    expect(subagentTool?.promptGuidelines).toBeUndefined();
  });
});
