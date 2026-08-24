import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DefaultResourceLoader,
  ExtensionRunner,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { MinimalSubagentsModelRole } from "../src/minimal-subagents-config.js";
import { createCoordinatorToolSchemas } from "../src/minimal-subagents-tool-schemas.js";
import {
  createCoordinatorToolDefinitions,
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

async function createToolExecutionContext() {
  const cwd = process.cwd();
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: tmpdir(),
    noExtensions: true,
    noContextFiles: true,
    noPromptTemplates: true,
    noSkills: true,
    noThemes: true,
  });
  await resourceLoader.reload();
  const extensions = resourceLoader.getExtensions();
  const modelRuntime = await ModelRuntime.create({
    authPath: join(tmpdir(), "minimal-subagents-tools-auth.json"),
    modelsPath: null,
  });
  return new ExtensionRunner(
    extensions.extensions,
    extensions.runtime,
    cwd,
    SessionManager.inMemory(cwd),
    new ModelRegistry(modelRuntime),
  ).createContext();
}

describe("minimal subagents coordinator tools", () => {
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

    const waitTool = requireTool(options, "subagent_wait");
    await waitTool.execute(
      "wait-call",
      { agent_id: "child", turn_id: "child:older", timeout_ms: 50 },
      signal,
      undefined,
      await createToolExecutionContext(),
    );

    expect(options.coordinator.wait).toHaveBeenCalledWith(
      "root",
      "child",
      50,
      signal,
      "child:older",
    );
  });
});
