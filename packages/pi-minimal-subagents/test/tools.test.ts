import { toToolContext } from "./tool-context.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DefaultResourceLoader,
  ExtensionRunner,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, setKeybindings } from "@earendil-works/pi-tui";
import { taggedTheme } from "@ian-pascoe/pi-utils/ui-testing";
import { Value } from "typebox/value";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { MinimalSubagentsModelRole } from "../src/minimal-subagents-config.js";
import { CoordinatorToolOutputSchemas } from "../src/minimal-subagents-render-contract.js";
import { TROUBLESHOOTING_HINT } from "../src/troubleshooting-skill.js";
import { createCoordinatorToolSchemas } from "../src/minimal-subagents-tool-schemas.js";
import {
  createCoordinatorToolDefinitions,
  type CoordinatorToolDefinitionOptions,
  type CoordinatorToolOperations,
} from "../src/minimal-subagents-tools.js";
import type {
  ActiveTurnProgress,
  AgentDetail,
  WaitTimeoutResult,
} from "../src/minimal-subagents-types.js";

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
    previewActiveTurn: vi.fn<CoordinatorToolOperations["previewActiveTurn"]>(() => undefined),
    inspectActiveTurnTranscript: vi.fn<CoordinatorToolOperations["inspectActiveTurnTranscript"]>(
      () => undefined,
    ),
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
  it("gives children that cannot spawn only agent_message", () => {
    expect(
      createCoordinatorToolDefinitions(toolOptions("child", false)).map(({ name }) => name),
    ).toEqual(["agent_message"]);
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

  it("declares role as a plain string whose schema does not depend on the configured roles", () => {
    const withRoles = createCoordinatorToolDefinitions(
      toolOptions("root", true, [{ name: "explore", model: "provider/model" }]),
    );
    const withoutRoles = createCoordinatorToolDefinitions(toolOptions("root", true));

    expect(JSON.stringify(withRoles.map(({ parameters }) => parameters))).toBe(
      JSON.stringify(withoutRoles.map(({ parameters }) => parameters)),
    );
    const role = createCoordinatorToolSchemas(["provider/model"]).subagent.properties.role;
    expect(role).toMatchObject({ type: "string", minLength: 1 });
    expect(role).not.toHaveProperty("enum");
  });

  it("runs a spawn sequentially so later calls in the same batch can target the new child", () => {
    const tools = createCoordinatorToolDefinitions(toolOptions("root", true));
    expect(
      Object.fromEntries(tools.map(({ name, executionMode }) => [name, executionMode])),
    ).toEqual({
      subagent: "sequential",
      agent_message: undefined,
      subagent_wait: undefined,
      subagent_status: undefined,
      subagent_cancel: undefined,
      subagent_delete: undefined,
    });
  });

  it("returns a compact spawn result while keeping full detail for the transcript renderer", async () => {
    const options = toolOptions("root", true);
    const spawned = {
      agent_id: "child",
      turn_id: "child:turn-1",
      status: "running" as const,
      model: "provider/model",
      thinking_level: "medium" as const,
      tools: ["read"],
      delegation: "none" as const,
    };
    vi.mocked(options.coordinator.spawn).mockResolvedValue(spawned);
    const agent = {
      ...spawned,
      parent_id: "root",
      state: "running" as const,
      availability: "available" as const,
      child_count: 0,
      task: "Investigate",
      launch_contract: {
        session_context: "omit" as const,
        project_context: "inherit" as const,
        model: "provider/model",
        thinking_level: "medium" as const,
        tools: "read" as const,
        ordinary_tools: ["read"],
      },
      capability_ceiling: ["read"],
      spawn_entry_id: "entry",
      recent_messages: [],
      recent_activity: [],
      missing_dependencies: [],
    };
    vi.mocked(options.coordinator.inspectStatus).mockReturnValue({ agent });

    const result = await requireTool(options, "subagent").execute(
      "spawn-call",
      { task: "Investigate" },
      undefined,
      undefined,
      await createToolExecutionContext(),
    );

    expect(result.structuredContent).toEqual(spawned);
    expect(Value.Check(CoordinatorToolOutputSchemas.subagent, result.structuredContent)).toBe(true);
    expect(result.content).toEqual([
      {
        type: "text",
        text: "Spawned child (turn child:turn-1, running) · provider/model (medium) · tools: inherited, 1 tool · delegation none",
      },
    ]);
    expect(result.details).toEqual({ ...spawned, agent });
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

  describe("usage cost presentation", () => {
    const noisyUsage = {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 7,
      cacheWrite1h: 0,
      reasoning: 0,
      totalTokens: 22,
      cost: {
        input: 0.000022999999999999997,
        output: 0.0018,
        cacheRead: 0,
        cacheWrite: 0.011296249999999999,
        total: 0.014415649999999999,
      },
    };
    const roundedCost = {
      input: 0.000023,
      output: 0.0018,
      cacheRead: 0,
      cacheWrite: 0.011296,
      total: 0.014416,
    };

    it("reports one rounded usage total in subagent_wait text and keeps exact details", async () => {
      const options = toolOptions("root", true);
      options.recordedWait.mockResolvedValue({
        event: "turn",
        agent_id: "child",
        turn_id: "child:1",
        status: "completed",
        output: "done",
        usage: noisyUsage,
      });

      const result = await requireTool(options, "subagent_wait").execute(
        "wait-call",
        { agent_id: "child", timeout_ms: 50 },
        new AbortController().signal,
        undefined,
        await createToolExecutionContext(),
      );

      const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
      expect(text).not.toMatch(/\d\.\d{7,}/);
      expect(text).toBe("child turn child:1 completed\nusage: 22 tokens · $0.01\n\ndone");
      expect(result.structuredContent).toMatchObject({ usage: { cost: roundedCost } });
      expect(result.details).toMatchObject({ usage: { cost: noisyUsage.cost } });
    });

    it("rounds cost in subagent_status text and structuredContent", async () => {
      const options = toolOptions("root", true);
      const detail: AgentDetail = {
        agent_id: "child",
        parent_id: "root",
        model: "provider/model",
        thinking_level: "off",
        state: "idle",
        availability: "available",
        tools: [],
        child_count: 0,
        launch_contract: {
          model: "provider/model",
          thinking_level: "off",
          session_context: "omit",
          project_context: "omit",
          tools: undefined,
          ordinary_tools: [],
        },
        capability_ceiling: [],
        spawn_entry_id: "entry",
        recent_messages: [],
        recent_activity: [],
        missing_dependencies: [],
        latest_result: {
          agent_id: "child",
          turn_id: "child:1",
          status: "completed",
          output: "x",
          usage: noisyUsage,
        },
        usage: noisyUsage,
      };
      const partialStatus = { agent: detail };
      options.coordinator.status = vi.fn<CoordinatorToolOperations["status"]>(() => partialStatus);

      const result = await requireTool(options, "subagent_status").execute(
        "status-call",
        { agent_id: "child" },
        undefined,
        undefined,
        await createToolExecutionContext(),
      );

      const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
      expect(text).not.toMatch(/\d\.\d{7,}/);
      expect(text).toContain("Pass verbose: true");
      // Scripts keep the complete record the text summarizes.
      expect(result.structuredContent).toEqual({
        agent: {
          ...detail,
          usage: { ...noisyUsage, cost: roundedCost },
          latest_result: { ...detail.latest_result, usage: { ...noisyUsage, cost: roundedCost } },
        },
      });

      const verbose = await requireTool(options, "subagent_status").execute(
        "status-call",
        { agent_id: "child", verbose: true },
        undefined,
        undefined,
        await createToolExecutionContext(),
      );
      const verboseText = verbose.content
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("");
      expect(verboseText).toContain("usage: input 10 · output 5");
      expect(verboseText).not.toContain("Pass verbose: true");
    });
  });

  it("returns a timeout in its declared compact output shape", async () => {
    const options = toolOptions("root", true);
    const timeout = {
      event: "timeout",
      agent_id: "child",
      turn_id: "child:turn-1",
      timeout_ms: 50,
      state: "running",
      elapsed_ms: 60,
      latest_activity_at: "2026-01-01T00:00:00.000Z",
      total_tokens: 15,
      recent_activity_labels: ["tool call read"],
    } satisfies WaitTimeoutResult;
    options.recordedWait.mockResolvedValue(timeout);
    const result = await requireTool(options, "subagent_wait").execute(
      "wait-call",
      { agent_id: "child", timeout_ms: 50 },
      undefined,
      undefined,
      await createToolExecutionContext(),
    );
    expect(result.structuredContent).toEqual({
      ...timeout,
      source_agent_id: "child",
      source_turn_id: "child:turn-1",
    });
    expect(Value.Check(CoordinatorToolOutputSchemas.subagent_wait, result.structuredContent)).toBe(
      true,
    );
  });

  it("reports an already-delivered result in one line with its declared output shape", async () => {
    const options = toolOptions("root", true);
    const alreadyDelivered = {
      event: "turn",
      agent_id: "child",
      turn_id: "child:turn-1",
      status: "completed",
      already_delivered: true,
    } as const;
    const drainedMessage = {
      event: "message",
      agent_id: "child",
      turn_id: "child:turn-1",
      message_id: "message-1",
      delivery_id: "delivery-1",
      message: "progress 1",
    } as const;
    options.recordedWait
      .mockResolvedValueOnce(alreadyDelivered)
      .mockResolvedValueOnce({ ...alreadyDelivered, messages: [drainedMessage] });
    const waitTool = requireTool(options, "subagent_wait");
    const context = await createToolExecutionContext();

    const notice = await waitTool.execute(
      "wait-call",
      { agent_id: "child" },
      undefined,
      undefined,
      context,
    );
    expect(notice.content).toEqual([
      {
        type: "text",
        text: 'Result of child turn child:turn-1 (completed) was already delivered automatically; call subagent_wait with turn_id "child:turn-1" to reread it.',
      },
    ]);
    expect(notice.structuredContent).toEqual({
      ...alreadyDelivered,
      source_agent_id: "child",
      source_turn_id: "child:turn-1",
    });
    expect(Value.Check(CoordinatorToolOutputSchemas.subagent_wait, notice.structuredContent)).toBe(
      true,
    );

    // Coordination Messages the wait drained follow the notice, since the parent has not seen them.
    const withMessages = await waitTool.execute(
      "wait-call",
      { agent_id: "child" },
      undefined,
      undefined,
      context,
    );
    expect(JSON.stringify(withMessages.content)).toContain("progress 1");
    expect(withMessages.structuredContent).toMatchObject({ messages: [drainedMessage] });
    expect(
      Value.Check(CoordinatorToolOutputSchemas.subagent_wait, withMessages.structuredContent),
    ).toBe(true);

    // A result handed to Pi but not yet in the caller's branch arrives after this tool result.
    const pending = { ...alreadyDelivered, delivery_pending: true } as const;
    options.recordedWait.mockResolvedValueOnce(pending);
    const pendingNotice = await waitTool.execute(
      "wait-call",
      { agent_id: "child" },
      undefined,
      undefined,
      context,
    );
    expect(pendingNotice.content).toEqual([
      {
        type: "text",
        text: "Result of child turn child:turn-1 (completed) was handed to you automatically and arrives as a separate message; no reread is needed.",
      },
    ]);
    expect(pendingNotice.structuredContent).toEqual({
      ...pending,
      source_agent_id: "child",
      source_turn_id: "child:turn-1",
    });
    expect(
      Value.Check(CoordinatorToolOutputSchemas.subagent_wait, pendingNotice.structuredContent),
    ).toBe(true);
  });

  it("streams the waited-on child's running-turn progress in partial wait updates", async () => {
    const options = toolOptions("root", true);
    const progress: ActiveTurnProgress = { turn_id: "child:turn-1", tool_calls: 2 };
    vi.mocked(options.coordinator.previewActiveTurn).mockReturnValue(progress);
    options.recordedWait.mockResolvedValue({
      event: "turn",
      agent_id: "child",
      turn_id: "child:turn-1",
      status: "completed",
      output: "done",
    });
    const onUpdate = vi.fn();

    await requireTool(options, "subagent_wait").execute(
      "wait-call",
      { agent_id: "child", turn_id: "child:turn-1" },
      undefined,
      onUpdate,
      await createToolExecutionContext(),
    );

    expect(options.coordinator.previewActiveTurn).toHaveBeenCalledWith(
      "root",
      "child",
      "child:turn-1",
    );
    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({ agent_id: "child", status: "waiting", ...progress }),
      }),
    );
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
    expect(onAttention).toHaveBeenCalledWith("Deletion partially failed for child");
  });

  it("says when subagent_cancel found no active turn", async () => {
    const options = toolOptions("root", true);
    const cancellation = {
      agent_id: "child",
      recursive: false,
      affected_agent_ids: [],
      cancelled_turn_ids: [],
    };
    vi.mocked(options.coordinator.cancel).mockResolvedValue(cancellation);

    const result = await requireTool(options, "subagent_cancel").execute(
      "cancel-call",
      { agent_id: "child", recursive: false },
      undefined,
      undefined,
      await createToolExecutionContext(),
    );

    expect(result.content).toEqual([
      { type: "text", text: "Nothing cancelled: child had no active turn." },
    ]);
    expect(result.structuredContent).toEqual(cancellation);
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

describe("minimal subagents tool row footers", () => {
  type RenderContext = Parameters<NonNullable<ReturnType<typeof requireTool>["renderResult"]>>[3];

  function fakeContext(
    state: RenderContext["state"],
    overrides: Partial<RenderContext> & { args: RenderContext["args"] },
  ): RenderContext {
    return {
      toolCallId: "call",
      invalidate: vi.fn(),
      lastComponent: undefined,
      state,
      cwd: "/project",
      executionStarted: true,
      argsComplete: true,
      isPartial: false,
      expanded: false,
      showImages: false,
      isError: false,
      durationMs: undefined,
      outputPad: 1,
      ...overrides,
    };
  }

  // SAFETY: The renderers read only fg, bg, and bold, which the tagged test theme provides.
  const theme = taggedTheme as Theme;
  const cancelResult = {
    content: [],
    details: {
      agent_id: "child",
      recursive: true,
      affected_agent_ids: ["child"],
      cancelled_turn_ids: ["child:turn-1"],
    },
  };

  beforeAll(() => {
    setKeybindings(new KeybindingsManager({ "app.tools.expand": { defaultKeys: "ctrl+o" } }));
  });
  afterEach(() => vi.useRealTimers());

  it("shows a live Elapsed footer on the call row, then Took on the result row", () => {
    vi.useFakeTimers();
    const tool = requireTool(toolOptions("root", true), "subagent_cancel");
    const state = {};
    const args = { agent_id: "child" };

    const call = tool.renderCall?.(args, theme, fakeContext(state, { args, isPartial: true }));
    expect(call?.render(120).join("\n")).toContain("subagent_cancel");
    vi.advanceTimersByTime(2_000);
    expect(call?.render(120).join("\n")).toContain("<muted>Elapsed 2.0s</muted>");

    const result = tool.renderResult?.(
      cancelResult,
      { expanded: false, isPartial: false },
      theme,
      fakeContext(state, { args, durationMs: 2_100 }),
    );
    const lines = result?.render(120).map((line) => line.trimEnd());
    expect(lines?.at(-1)).toBe("<muted>Took 2.1s</muted>");
    // Pi's blank line separates the footer from the body, as in its bash renderer.
    expect(lines?.at(-2)).toBe("");
    expect(call?.render(120).join("\n")).not.toContain("Elapsed");
  });

  it("shows Elapsed under a streaming wait's progress", () => {
    vi.useFakeTimers();
    const tool = requireTool(toolOptions("root", true), "subagent_wait");
    const state = {};
    const args = { agent_id: "child" };
    const call = tool.renderCall?.(args, theme, fakeContext(state, { args, isPartial: true }));
    expect(call?.render(120).join("\n")).not.toContain("Elapsed");

    const progress = {
      content: [{ type: "text" as const, text: "Waiting for child" }],
      details: { agent_id: "child", status: "waiting", elapsed_ms: 1_000 },
    };
    const render = () =>
      tool.renderResult?.(
        progress,
        { expanded: false, isPartial: true },
        theme,
        fakeContext(state, { args, isPartial: true }),
      );
    render();
    vi.advanceTimersByTime(3_000);
    expect(
      render()
        ?.render(120)
        .map((line) => line.trimEnd())
        .at(-1),
    ).toBe("<muted>Elapsed 3.0s</muted>");
    // Finish the row so its once-a-second redraw timer stops.
    tool.renderResult?.(
      { content: [], details: { ...cancelResult.details } },
      { expanded: false, isPartial: false },
      theme,
      fakeContext(state, { args, durationMs: 3_000 }),
    );
  });
});
