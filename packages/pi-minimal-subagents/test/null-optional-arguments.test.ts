import {
  expectNullOptionalArgumentsOmitted,
  recordToolRegistrations,
} from "@ian-pascoe/pi-utils/tool-testing";
import { expect, test, vi } from "vitest";
import { createMinimalSubagentsExtension } from "../src/minimal-subagents-extension.js";
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
} satisfies CoordinatorToolOperations;

const COORDINATOR_TOOLS = [
  "subagent",
  "agent_message",
  "subagent_wait",
  "subagent_status",
  "subagent_cancel",
  "subagent_delete",
];

test.each([
  { caller: "a spawning agent", allowFanoutTools: true },
  { caller: "a child that may not spawn", allowFanoutTools: false },
])(
  "coordinator tools for $caller treat null for an optional parameter like omitting it",
  ({ allowFanoutTools }) => {
    const tools = createCoordinatorToolDefinitions({
      coordinator,
      callerId: "child",
      allowFanoutTools,
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
    if (allowFanoutTools) {
      expect(proven.get("subagent_status")).toEqual(["agent_id"]);
      expect(proven.get("subagent_wait")).toEqual(
        expect.arrayContaining(["turn_id", "timeout_ms"]),
      );
      expect(proven.get("subagent")).toEqual(
        expect.arrayContaining(["agent_id", "role", "tools", "delegation"]),
      );
    }
  },
);

test("the extension registers every coordinator tool with null handling", async () => {
  const { pi, tools } = recordToolRegistrations();
  await createMinimalSubagentsExtension()(pi);
  expect(tools.map(({ name }) => name)).toEqual(COORDINATOR_TOOLS);
  for (const tool of tools) expectNullOptionalArgumentsOmitted(tool);
});
