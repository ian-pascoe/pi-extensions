import { expectNullOptionalArgumentsOmitted } from "@ian-pascoe/pi-utils/tool-testing";
import { expect, test, vi } from "vitest";
import { createCoordinatorToolSchemas } from "../src/minimal-subagents-tool-schemas.js";
import {
  createCoordinatorToolDefinitions,
  type CoordinatorToolOperations,
} from "../src/minimal-subagents-tools.js";

const coordinator = {
  spawn: vi.fn<CoordinatorToolOperations["spawn"]>(),
  inspectStatus: vi.fn<CoordinatorToolOperations["inspectStatus"]>(),
  previewActiveTurn: vi.fn<CoordinatorToolOperations["previewActiveTurn"]>(),
  inspectActiveTurnTranscript: vi.fn<CoordinatorToolOperations["inspectActiveTurnTranscript"]>(),
  sendAgentMessage: vi.fn<CoordinatorToolOperations["sendAgentMessage"]>(),
  wait: vi.fn<CoordinatorToolOperations["wait"]>(),
  status: vi.fn<CoordinatorToolOperations["status"]>(),
  cancel: vi.fn<CoordinatorToolOperations["cancel"]>(),
  delete: vi.fn<CoordinatorToolOperations["delete"]>(),
  assertCurrentCaller: vi.fn<CoordinatorToolOperations["assertCurrentCaller"]>(),
} satisfies CoordinatorToolOperations;

test("coordinator tools treat null for an optional parameter like omitting it", () => {
  const tools = createCoordinatorToolDefinitions({
    coordinator,
    callerId: "child",
    allowFanoutTools: true,
    schemas: createCoordinatorToolSchemas([]),
    captureCaller: () => {
      throw new Error("Not called");
    },
  });
  expect(tools.length).toBeGreaterThan(0);
  const proven = new Map(
    tools.map((tool) => [tool.name, expectNullOptionalArgumentsOmitted(tool)]),
  );
  expect(proven.get("agent_message")).toEqual(["agent_id"]);
  expect(proven.get("subagent_status")).toEqual(["agent_id", "verbose"]);
  expect(proven.get("subagent_wait")).toEqual(expect.arrayContaining(["turn_id", "timeout_ms"]));
  expect(proven.get("subagent")).toEqual(
    expect.arrayContaining(["agent_id", "role", "tools", "delegation"]),
  );
});
