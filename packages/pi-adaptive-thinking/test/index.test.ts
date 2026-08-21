import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentEndEvent,
  AgentToolResult,
  SessionStartEvent,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, test, vi } from "vitest";
import {
  type AdaptiveThinkingContext,
  type AdaptiveThinkingExtensionHost,
  type AdaptiveThinkingSetThinkingLevelParameters,
  type AdaptiveThinkingToolDefinition,
  isAdaptiveThinkingSetThinkingLevelTool,
  isAdaptiveThinkingStatusTool,
  registerAdaptiveThinking,
} from "../src/adaptive-thinking-lifecycle.js";

type ToolCallFixture = Omit<Extract<ToolCallEvent, { toolName: string }>, "type">;
type SessionStartFixture = Omit<SessionStartEvent, "type">;

class RecordingAdaptiveThinkingContext implements AdaptiveThinkingContext {
  readonly notify = vi.fn<(message: string, type?: "info" | "warning" | "error") => void>();
  readonly ui = { notify: this.notify };
  readonly hasUI: boolean;
  readonly model: AdaptiveThinkingContext["model"];
  readonly cwd: string;

  constructor({
    cwd = "/tmp/project",
    hasUI = true,
    model,
  }: {
    readonly cwd?: string;
    readonly hasUI?: boolean;
    readonly model?: AdaptiveThinkingContext["model"];
  } = {}) {
    this.cwd = cwd;
    this.hasUI = hasUI;
    this.model = model;
  }
}

class RecordingAdaptiveThinkingHost implements AdaptiveThinkingExtensionHost {
  readonly tools: AdaptiveThinkingToolDefinition[] = [];
  readonly getThinkingLevel = vi.fn<() => string>(() => "medium");
  readonly setThinkingLevel =
    vi.fn<(level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max") => void>();
  sessionStartHandler:
    | ((event: SessionStartEvent, context: AdaptiveThinkingContext) => Promise<void> | void)
    | undefined;
  toolCallHandler:
    | ((
        event: ToolCallEvent,
        context: AdaptiveThinkingContext,
      ) => Promise<ToolCallEventResult | void> | ToolCallEventResult | void)
    | undefined;
  agentEndHandler:
    | ((event: AgentEndEvent, context: AdaptiveThinkingContext) => Promise<void> | void)
    | undefined;

  onSessionStart(
    handler: (event: SessionStartEvent, context: AdaptiveThinkingContext) => Promise<void> | void,
  ) {
    this.sessionStartHandler = handler;
  }

  onToolCall(
    handler: (
      event: ToolCallEvent,
      context: AdaptiveThinkingContext,
    ) => Promise<ToolCallEventResult | void> | ToolCallEventResult | void,
  ) {
    this.toolCallHandler = handler;
  }

  onAgentEnd(
    handler: (event: AgentEndEvent, context: AdaptiveThinkingContext) => Promise<void> | void,
  ) {
    this.agentEndHandler = handler;
  }

  registerTool(tool: AdaptiveThinkingToolDefinition) {
    this.tools.push(tool);
  }

  async emitSessionStart(
    event: SessionStartFixture,
    context: AdaptiveThinkingContext,
  ): Promise<void> {
    if (this.sessionStartHandler === undefined) throw new Error("Expected session-start handler");
    await this.sessionStartHandler({ type: "session_start", ...event }, context);
  }

  async emitToolCall(event: ToolCallFixture, context: AdaptiveThinkingContext): Promise<void> {
    if (this.toolCallHandler === undefined) throw new Error("Expected tool-call handler");
    await this.toolCallHandler({ type: "tool_call", ...event }, context);
  }

  async emitAgentEnd(context: AdaptiveThinkingContext): Promise<void> {
    if (this.agentEndHandler === undefined) throw new Error("Expected agent-end handler");
    await this.agentEndHandler({ type: "agent_end", messages: [] }, context);
  }
}

const createPi = () => new RecordingAdaptiveThinkingHost();

const createCtx = (
  overrides: ConstructorParameters<typeof RecordingAdaptiveThinkingContext>[0] = {},
) => new RecordingAdaptiveThinkingContext(overrides);

const setThinkingLevelTool = (tools: readonly AdaptiveThinkingToolDefinition[]) => {
  const tool = tools.find(isAdaptiveThinkingSetThinkingLevelTool);
  if (tool === undefined) throw new Error("Expected set-thinking-level tool");
  return tool;
};

const statusThinkingLevelTool = (tools: readonly AdaptiveThinkingToolDefinition[]) => {
  const tool = tools.find(isAdaptiveThinkingStatusTool);
  if (tool === undefined) throw new Error("Expected status tool");
  return tool;
};

const toolResultText = (result: AgentToolResult<unknown>): string => {
  const content = result.content.at(0);
  if (content?.type !== "text") throw new Error("Expected text tool result");
  return content.text;
};

const setThinkingLevelParameters = (
  level: string,
  persist: boolean,
): AdaptiveThinkingSetThinkingLevelParameters => ({ level, persist });

describe("adaptiveThinking extension", () => {
  test("registers static thinking tools without a system prompt handler", async () => {
    const host = createPi();
    registerAdaptiveThinking(host);
    const { tools } = host;

    await host.emitSessionStart({ reason: "startup" }, createCtx());

    expect(setThinkingLevelTool(tools).name).toBe("set_thinking_level");
    expect(statusThinkingLevelTool(tools).name).toBe("get_thinking_level");
    expect(setThinkingLevelTool(tools).promptGuidelines).toEqual(
      expect.arrayContaining([
        expect.stringContaining("manage thinking level actively"),
        expect.stringContaining("get_thinking_level"),
      ]),
    );
    expect(JSON.stringify(tools)).not.toContain("Current thinking level");
    expect(JSON.stringify(tools)).not.toContain("Valid thinking levels");
  });

  test("reports native current and model-supported thinking levels", async () => {
    const host = createPi();
    const { tools } = host;
    const pi = host;
    vi.mocked(pi.getThinkingLevel).mockReturnValue("high");
    registerAdaptiveThinking(host);
    await host.emitSessionStart({ reason: "startup" }, createCtx());

    const statusTool = statusThinkingLevelTool(tools);
    const result = await statusTool.execute("status-call", {}, undefined, undefined, createCtx());

    expect(toolResultText(result)).toBe(
      "Current thinking level: high. Supported thinking levels: off, minimal, low, medium, high, xhigh, max.",
    );
    expect(result.details).toEqual({
      currentLevel: "high",
      supportedLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    });
  });

  test("reports an unknown native current level without coercing it", async () => {
    const host = createPi();
    const { tools } = host;
    const pi = host;
    vi.mocked(pi.getThinkingLevel).mockReturnValue("turbo");
    registerAdaptiveThinking(host);
    await host.emitSessionStart({ reason: "startup" }, createCtx());

    const statusTool = statusThinkingLevelTool(tools);
    const result = await statusTool.execute("status-call", {}, undefined, undefined, createCtx());

    expect(result.details.currentLevel).toBe("unknown");
  });

  test("keeps tool metadata stable across runtime state changes", async () => {
    const host = createPi();
    const { tools } = host;
    registerAdaptiveThinking(host);
    await host.emitSessionStart({ reason: "startup" }, createCtx());
    const registeredMetadata = JSON.stringify(tools);

    await statusThinkingLevelTool(tools).execute("status", {}, undefined, undefined, createCtx());
    await host.emitToolCall(
      { toolName: "set_thinking_level", toolCallId: "setter", input: {} },
      createCtx(),
    );
    await setThinkingLevelTool(tools).execute(
      "setter",
      setThinkingLevelParameters("high", false),
      undefined,
      undefined,
      createCtx(),
    );
    await host.emitAgentEnd(createCtx());

    expect(JSON.stringify(tools)).toBe(registeredMetadata);
  });

  test("deprecated systemPrompt config warns without entering model context", async () => {
    const project = join(tmpdir(), `pi-adaptive-thinking-config-${Date.now()}`);
    mkdirSync(join(project, ".pi"), { recursive: true });
    writeFileSync(
      join(project, ".pi", "adaptive-thinking.json"),
      JSON.stringify({ systemPrompt: "Legacy static guidance" }),
    );

    try {
      const host = createPi();
      const { tools } = host;
      const ctx = createCtx({ cwd: project });
      registerAdaptiveThinking(host);
      await host.emitSessionStart({ reason: "startup" }, ctx);

      expect(ctx.notify).toHaveBeenCalledWith(
        "Adaptive Thinking configuration: systemPrompt is deprecated; rename it to guidance.",
        "warning",
      );
      expect(setThinkingLevelTool(tools).promptGuidelines).toContain("Legacy static guidance");
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  test("same-level tool call is a no-op", async () => {
    const host = createPi();
    const { tools } = host;
    const pi = host;
    registerAdaptiveThinking(host);
    await host.emitSessionStart({ reason: "startup" }, createCtx());

    const result = await setThinkingLevelTool(tools).execute(
      "tool-call",
      setThinkingLevelParameters("medium", false),
      undefined,
      undefined,
      createCtx(),
    );

    expect(toolResultText(result)).toBe("Thinking level is already medium; no change made.");
    expect(pi.setThinkingLevel).not.toHaveBeenCalled();
  });

  test("setter uses native thinking level as its source of truth", async () => {
    const host = createPi();
    const { tools } = host;
    const pi = host;
    registerAdaptiveThinking(host);
    await host.emitSessionStart({ reason: "startup" }, createCtx());
    vi.mocked(pi.getThinkingLevel).mockReturnValue("high");

    const result = await setThinkingLevelTool(tools).execute(
      "tool-call",
      setThinkingLevelParameters("high", false),
      undefined,
      undefined,
      createCtx(),
    );

    expect(toolResultText(result)).toBe("Thinking level is already high; no change made.");
    expect(pi.setThinkingLevel).not.toHaveBeenCalled();
  });

  test("temporary change fails when the Session Baseline is unknown", async () => {
    const host = createPi();
    const { tools } = host;
    const pi = host;
    vi.mocked(pi.getThinkingLevel).mockReturnValue("turbo");
    registerAdaptiveThinking(host);
    await host.emitSessionStart({ reason: "startup" }, createCtx());

    const result = await setThinkingLevelTool(tools).execute(
      "tool-call",
      setThinkingLevelParameters("high", false),
      undefined,
      undefined,
      createCtx(),
    );

    expect(toolResultText(result)).toBe(
      "Cannot apply a temporary thinking level because the Session Baseline is unknown.",
    );
    expect(pi.setThinkingLevel).not.toHaveBeenCalled();
  });

  test("back-to-back reasoning tool calls are no-ops", async () => {
    const host = createPi();
    const { tools } = host;
    const pi = host;
    registerAdaptiveThinking(host);
    await host.emitSessionStart({ reason: "startup" }, createCtx());

    await host.emitToolCall(
      { toolName: "set_thinking_level", toolCallId: "first", input: {} },
      createCtx(),
    );
    await setThinkingLevelTool(tools).execute(
      "first",
      setThinkingLevelParameters("high", false),
      undefined,
      undefined,
      createCtx(),
    );
    vi.mocked(pi.setThinkingLevel).mockClear();

    await host.emitToolCall(
      { toolName: "set_thinking_level", toolCallId: "second", input: {} },
      createCtx(),
    );
    const result = await setThinkingLevelTool(tools).execute(
      "second",
      setThinkingLevelParameters("low", false),
      undefined,
      undefined,
      createCtx(),
    );

    expect(toolResultText(result)).toBe(
      "Thinking level change skipped because the previous tool call was also set_thinking_level. Reassess after another tool call or new user input.",
    );
    expect(pi.setThinkingLevel).not.toHaveBeenCalled();
  });

  test("status inspection allows a following thinking-level change", async () => {
    const host = createPi();
    const { tools } = host;
    const pi = host;
    registerAdaptiveThinking(host);
    await host.emitSessionStart({ reason: "startup" }, createCtx());

    await host.emitToolCall(
      { toolName: "get_thinking_level", toolCallId: "status", input: {} },
      createCtx(),
    );
    await statusThinkingLevelTool(tools).execute("status", {}, undefined, undefined, createCtx());
    await host.emitToolCall(
      { toolName: "set_thinking_level", toolCallId: "setter", input: {} },
      createCtx(),
    );
    const result = await setThinkingLevelTool(tools).execute(
      "setter",
      setThinkingLevelParameters("high", true),
      undefined,
      undefined,
      createCtx(),
    );

    expect(toolResultText(result)).toBe("Thinking level set to high");
    expect(pi.setThinkingLevel).toHaveBeenCalledWith("high");
  });

  test("back-to-back state is tracked per tool call", async () => {
    const host = createPi();
    const { tools } = host;
    const pi = host;
    registerAdaptiveThinking(host);
    await host.emitSessionStart({ reason: "startup" }, createCtx());

    await host.emitToolCall(
      { toolName: "set_thinking_level", toolCallId: "first", input: {} },
      createCtx(),
    );
    await host.emitToolCall(
      { toolName: "set_thinking_level", toolCallId: "second", input: {} },
      createCtx(),
    );

    const firstResult = await setThinkingLevelTool(tools).execute(
      "first",
      setThinkingLevelParameters("high", false),
      undefined,
      undefined,
      createCtx(),
    );
    vi.mocked(pi.setThinkingLevel).mockClear();

    const secondResult = await setThinkingLevelTool(tools).execute(
      "second",
      setThinkingLevelParameters("low", false),
      undefined,
      undefined,
      createCtx(),
    );

    expect(toolResultText(firstResult)).toBe("Thinking level set to high");
    expect(toolResultText(secondResult)).toBe(
      "Thinking level change skipped because the previous tool call was also set_thinking_level. Reassess after another tool call or new user input.",
    );
    expect(pi.setThinkingLevel).not.toHaveBeenCalled();
  });

  test("intervening tool call allows another reasoning change", async () => {
    const host = createPi();
    const { tools } = host;
    const pi = host;
    registerAdaptiveThinking(host);
    await host.emitSessionStart({ reason: "startup" }, createCtx());

    await host.emitToolCall(
      { toolName: "set_thinking_level", toolCallId: "first", input: {} },
      createCtx(),
    );
    await setThinkingLevelTool(tools).execute(
      "first",
      setThinkingLevelParameters("high", true),
      undefined,
      undefined,
      createCtx(),
    );
    vi.mocked(pi.setThinkingLevel).mockClear();

    await host.emitToolCall(
      { toolName: "read", toolCallId: "read", input: { path: "src/index.ts" } },
      createCtx(),
    );
    await host.emitToolCall(
      { toolName: "set_thinking_level", toolCallId: "second", input: {} },
      createCtx(),
    );
    const result = await setThinkingLevelTool(tools).execute(
      "second",
      setThinkingLevelParameters("low", true),
      undefined,
      undefined,
      createCtx(),
    );

    expect(toolResultText(result)).toBe("Thinking level set to low");
    expect(pi.setThinkingLevel).toHaveBeenCalledWith("low");
  });

  test("persistent tool call sets baseline and does not reset on agent_end", async () => {
    const host = createPi();
    const { tools } = host;
    const pi = host;
    registerAdaptiveThinking(host);
    await host.emitSessionStart({ reason: "startup" }, createCtx());

    const result = await setThinkingLevelTool(tools).execute(
      "tool-call",
      setThinkingLevelParameters("high", true),
      undefined,
      undefined,
      createCtx(),
    );

    expect(toolResultText(result)).toBe("Thinking level set to high");
    expect(pi.setThinkingLevel).toHaveBeenCalledWith("high");

    vi.mocked(pi.setThinkingLevel).mockClear();
    await host.emitAgentEnd(createCtx());
    expect(pi.setThinkingLevel).not.toHaveBeenCalled();
  });

  test("retries a contended settings lock without blocking the event loop", async () => {
    const agentDir = join(tmpdir(), `pi-adaptive-thinking-lock-${Date.now()}`);
    const settingsPath = join(agentDir, "settings.json");
    const lockPath = `${settingsPath}.adaptive-thinking.lock`;
    mkdirSync(agentDir, { recursive: true });
    // Hold the exclusive-create lock until a timer releases it mid-retry window.
    writeFileSync(lockPath, "");
    let released = false;
    const releaseTimer = setTimeout(() => {
      released = true;
      rmSync(lockPath, { force: true });
    }, 50);

    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;

    try {
      const host = createPi();
      const { tools } = host;
      registerAdaptiveThinking(host);
      await host.emitSessionStart({ reason: "startup" }, createCtx());

      const result = await setThinkingLevelTool(tools).execute(
        "tool-call",
        setThinkingLevelParameters("high", true),
        undefined,
        undefined,
        createCtx(),
      );

      expect(released).toBe(true);
      expect(toolResultText(result)).toBe("Thinking level set to high");
      expect(host.setThinkingLevel).toHaveBeenCalledWith("high");
    } finally {
      clearTimeout(releaseTimer);
      rmSync(lockPath, { force: true });
      if (previousAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
      rmSync(agentDir, { recursive: true, force: true });
    }
  });

  test("persistent tool call does not update global default settings", async () => {
    const agentDir = join(tmpdir(), `pi-adaptive-thinking-${Date.now()}`);
    const settingsPath = join(agentDir, "settings.json");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({ defaultThinkingLevel: "max", theme: "dark" }));

    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;

    try {
      const host = createPi();
      const { tools } = host;
      const pi = host;
      vi.mocked(pi.setThinkingLevel).mockImplementation((level: string) => {
        const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
        settings.defaultThinkingLevel = level;
        settings.theme = "light";
        writeFileSync(settingsPath, JSON.stringify(settings));
      });

      registerAdaptiveThinking(host);
      await host.emitSessionStart({ reason: "startup" }, createCtx());

      await setThinkingLevelTool(tools).execute(
        "tool-call",
        setThinkingLevelParameters("high", true),
        undefined,
        undefined,
        createCtx(),
      );

      expect(JSON.parse(readFileSync(settingsPath, "utf-8"))).toEqual({
        defaultThinkingLevel: "max",
        theme: "light",
      });
    } finally {
      if (previousAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
      if (existsSync(agentDir)) rmSync(agentDir, { recursive: true, force: true });
    }
  });

  test("temporary tool call restores previous level on agent_end", async () => {
    const host = createPi();
    const { tools } = host;
    const pi = host;
    registerAdaptiveThinking(host);
    await host.emitSessionStart({ reason: "startup" }, createCtx());

    const result = await setThinkingLevelTool(tools).execute(
      "tool-call",
      setThinkingLevelParameters("high", false),
      undefined,
      undefined,
      createCtx(),
    );

    expect(toolResultText(result)).toBe("Thinking level set to high");
    expect(pi.setThinkingLevel).toHaveBeenCalledWith("high");

    await host.emitAgentEnd(createCtx());
    expect(pi.setThinkingLevel).toHaveBeenLastCalledWith("medium");
  });

  test("temporary change and reset both preserve the global default setting", async () => {
    const agentDir = join(tmpdir(), `pi-adaptive-thinking-temporary-${Date.now()}`);
    const settingsPath = join(agentDir, "settings.json");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({ defaultThinkingLevel: "max", theme: "dark" }));

    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;

    try {
      const host = createPi();
      const { tools } = host;
      const pi = host;
      vi.mocked(pi.setThinkingLevel).mockImplementation((level: string) => {
        const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
        settings.defaultThinkingLevel = level;
        settings.theme = "light";
        writeFileSync(settingsPath, JSON.stringify(settings));
      });

      registerAdaptiveThinking(host);
      await host.emitSessionStart({ reason: "startup" }, createCtx());
      await setThinkingLevelTool(tools).execute(
        "tool-call",
        setThinkingLevelParameters("high", false),
        undefined,
        undefined,
        createCtx(),
      );
      expect(JSON.parse(readFileSync(settingsPath, "utf-8"))).toEqual({
        defaultThinkingLevel: "max",
        theme: "light",
      });

      await host.emitAgentEnd(createCtx());
      expect(pi.setThinkingLevel).toHaveBeenLastCalledWith("medium");
      expect(JSON.parse(readFileSync(settingsPath, "utf-8"))).toEqual({
        defaultThinkingLevel: "max",
        theme: "light",
      });
    } finally {
      if (previousAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
      if (existsSync(agentDir)) rmSync(agentDir, { recursive: true, force: true });
    }
  });

  test("native manual selection becomes the temporary Session Baseline", async () => {
    const host = createPi();
    const { tools } = host;
    const pi = host;
    registerAdaptiveThinking(host);
    await host.emitSessionStart({ reason: "startup" }, createCtx());
    vi.mocked(pi.getThinkingLevel).mockReturnValue("low");

    await setThinkingLevelTool(tools).execute(
      "tool-call",
      setThinkingLevelParameters("high", false),
      undefined,
      undefined,
      createCtx(),
    );
    await host.emitAgentEnd(createCtx());

    expect(pi.setThinkingLevel).toHaveBeenLastCalledWith("low");
  });

  test("retains native max selection as the temporary Session Baseline", async () => {
    const host = createPi();
    const { tools } = host;
    const pi = host;
    registerAdaptiveThinking(host);
    await host.emitSessionStart({ reason: "startup" }, createCtx());
    vi.mocked(pi.getThinkingLevel).mockReturnValue("max");

    await setThinkingLevelTool(tools).execute(
      "tool-call",
      setThinkingLevelParameters("high", false),
      undefined,
      undefined,
      createCtx(),
    );
    await host.emitAgentEnd(createCtx());

    expect(pi.setThinkingLevel).toHaveBeenLastCalledWith("max");
  });

  test("invalid level returns error and does not call setter", async () => {
    const host = createPi();
    const { tools } = host;
    const pi = host;
    registerAdaptiveThinking(host);
    await host.emitSessionStart({ reason: "startup" }, createCtx());

    const result = await setThinkingLevelTool(tools).execute(
      "tool-call",
      setThinkingLevelParameters("turbo", false),
      undefined,
      undefined,
      createCtx(),
    );

    expect(toolResultText(result)).toContain("Invalid thinking level: turbo");
    expect(pi.setThinkingLevel).not.toHaveBeenCalled();
  });
});
