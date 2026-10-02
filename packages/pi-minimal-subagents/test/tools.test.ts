import { toToolContext } from "./tool-context.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DefaultResourceLoader,
  ExtensionRunner,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import type { MinimalSubagentsModelRole } from "../src/minimal-subagents-config.js";
import { CoordinatorToolOutputSchemas } from "../src/minimal-subagents-render-contract.js";
import { TROUBLESHOOTING_HINT } from "../src/troubleshooting-skill.js";
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
  return toToolContext(
    new ExtensionRunner(
      extensions.extensions,
      extensions.runtime,
      cwd,
      SessionManager.inMemory(cwd),
      new ModelRegistry(modelRuntime),
    ).createContext(),
  );
}

describe("minimal subagents coordinator tools", () => {
  it("gives ordinary children only the three adjacent-coordination tools", () => {
    expect(
      createCoordinatorToolDefinitions(toolOptions("child", false)).map(({ name }) => name),
    ).toEqual(["agent_message", "subagent_wait", "subagent_status"]);
  });

  it("attaches each coordinator tool's final details schema", () => {
    const outputSchemas = Object.fromEntries(
      createCoordinatorToolDefinitions(toolOptions("root", true)).map(({ name, outputSchema }) => [
        name,
        outputSchema,
      ]),
    );

    expect(outputSchemas).toEqual(CoordinatorToolOutputSchemas);
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
    const result = await waitTool.execute(
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
    // Script callers receive the declared object shape.
    expect(result.structuredContent).toEqual(result.details);
    expect(result.structuredContent).toMatchObject({ source_turn_id: "child:older" });
  });

  it("returns partial deletion failures as an error result that keeps the declared output", async () => {
    const options = toolOptions("root", true);
    const deletion = {
      agent_id: "child",
      recursive: true,
      deleted_agent_ids: ["child.leaf"],
      trashed_session_files: [],
      failures: [{ agent_id: "child", error: "disk full" }],
    };
    vi.mocked(options.coordinator.delete).mockResolvedValue(deletion);
    const onAttention = vi.fn<(message: string) => void>();
    options.onAttention = onAttention;

    const result = await requireTool(options, "subagent_delete").execute(
      "delete-call",
      { agent_id: "child" },
      undefined,
      undefined,
      await createToolExecutionContext(),
    );

    expect(result).toMatchObject({
      isError: true,
      details: deletion,
      structuredContent: deletion,
    });
    expect(
      Value.Check(CoordinatorToolOutputSchemas.subagent_delete, result.structuredContent),
    ).toBe(true);
    const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
    expect(text).toContain("Minimal subagents deletion partially failed");
    expect(text).toContain("disk full");
    // The model-facing text points at the troubleshooting Skill; structured data stays clean.
    expect(text).toContain(TROUBLESHOOTING_HINT);
    expect(JSON.stringify(result.structuredContent)).not.toContain(TROUBLESHOOTING_HINT);
    expect(onAttention).toHaveBeenCalledWith(
      "Minimal subagents deletion partially failed for child",
    );
  });

  it("returns complete deletion as a successful result", async () => {
    const options = toolOptions("root", true);
    vi.mocked(options.coordinator.delete).mockResolvedValue({
      agent_id: "child",
      recursive: true,
      deleted_agent_ids: ["child"],
      trashed_session_files: [],
      failures: [],
    });

    const result = await requireTool(options, "subagent_delete").execute(
      "delete-call",
      { agent_id: "child" },
      undefined,
      undefined,
      await createToolExecutionContext(),
    );

    expect(result.isError).toBeUndefined();
  });

  it("returns failed message delivery as an error result that keeps the declared output", async () => {
    const options = toolOptions("root", true);
    const delivery = {
      agent_id: "child",
      message_id: "message-1",
      disposition: "failed" as const,
      error: "delivery failed",
    };
    vi.mocked(options.coordinator.sendAgentMessage).mockResolvedValue(delivery);

    const failed = await requireTool(options, "agent_message").execute(
      "message-call",
      { agent_id: "child", message: "hello" },
      undefined,
      undefined,
      await createToolExecutionContext(),
    );
    expect(failed).toMatchObject({
      isError: true,
      details: delivery,
      structuredContent: delivery,
    });

    vi.mocked(options.coordinator.sendAgentMessage).mockResolvedValue({
      ...delivery,
      disposition: "queued",
    });
    const queued = await requireTool(options, "agent_message").execute(
      "message-call",
      { agent_id: "child", message: "hello" },
      undefined,
      undefined,
      await createToolExecutionContext(),
    );
    expect(queued.isError).toBeUndefined();
  });
});
