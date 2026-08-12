import { describe, expect, it, vi } from "vitest";
import { createCoordinatorToolSchemas } from "../src/minimal-subagents-tool-schemas.js";
import { createCoordinatorToolDefinitions } from "../src/minimal-subagents-tools.js";

function toolOptions(callerId: string, allowFanoutTools?: boolean) {
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
    schemas: createCoordinatorToolSchemas(["provider/model"]),
    captureCaller: vi.fn(),
  };
}

describe("minimal subagents coordinator tools", () => {
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
});
