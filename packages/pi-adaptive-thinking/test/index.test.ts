import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import adaptiveThinking from "../src/index.js";

type Handler = (event: any, ctx: any) => any;

const createPi = () => {
  const handlers = new Map<string, Handler[]>();
  const tools: any[] = [];
  const pi = {
    on: vi.fn((event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    }),
    registerTool: vi.fn((tool: any) => {
      tools.push(tool);
    }),
    getThinkingLevel: vi.fn(() => "medium"),
    setThinkingLevel: vi.fn(),
  };

  const emit = async (event: string, payload: any, ctx: any) => {
    let result: any;
    for (const handler of handlers.get(event) ?? []) {
      result = await handler(payload, ctx);
    }
    return result;
  };

  return { pi, tools, emit, handlers };
};

const createCtx = (overrides: Partial<any> = {}) => ({
  cwd: "/tmp/project",
  hasUI: true,
  ui: { notify: vi.fn() },
  model: undefined,
  ...overrides,
});

describe("adaptiveThinking extension", () => {
  test("registers static thinking tools without a system prompt handler", async () => {
    const { pi, tools, emit, handlers } = createPi();
    adaptiveThinking(pi as never);

    await emit("session_start", { reason: "startup" }, createCtx());

    expect(tools[0].name).toBe("set_thinking_level");
    expect(tools[1].name).toBe("get_thinking_level");
    expect(handlers.has("before_agent_start")).toBe(false);
    expect(tools[0].promptGuidelines).toEqual(
      expect.arrayContaining([
        expect.stringContaining("manage thinking level actively"),
        expect.stringContaining("get_thinking_level"),
      ]),
    );
    expect(JSON.stringify(tools)).not.toContain("Current thinking level");
    expect(JSON.stringify(tools)).not.toContain("Valid thinking levels");
  });

  test("reports native current and model-supported thinking levels", async () => {
    const { pi, tools, emit } = createPi();
    vi.mocked(pi.getThinkingLevel).mockReturnValue("high");
    adaptiveThinking(pi as never);
    await emit("session_start", { reason: "startup" }, createCtx());

    const statusTool = tools.find((tool) => tool.name === "get_thinking_level");
    const result = await statusTool.execute("status-call", {}, undefined, undefined, createCtx());

    expect(result.content[0].text).toBe(
      "Current thinking level: high. Supported thinking levels: off, minimal, low, medium, high, xhigh, max.",
    );
    expect(result.details).toEqual({
      currentLevel: "high",
      supportedLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    });
  });

  test("reports an unknown native current level without coercing it", async () => {
    const { pi, tools, emit } = createPi();
    vi.mocked(pi.getThinkingLevel).mockReturnValue("turbo" as never);
    adaptiveThinking(pi as never);
    await emit("session_start", { reason: "startup" }, createCtx());

    const statusTool = tools.find((tool) => tool.name === "get_thinking_level");
    const result = await statusTool.execute("status-call", {}, undefined, undefined, createCtx());

    expect(result.details.currentLevel).toBe("unknown");
  });

  test("keeps tool metadata stable across runtime state changes", async () => {
    const { pi, tools, emit } = createPi();
    adaptiveThinking(pi as never);
    await emit("session_start", { reason: "startup" }, createCtx());
    const registeredMetadata = JSON.stringify(tools);

    await tools[1].execute("status", {}, undefined, undefined, createCtx());
    await emit(
      "tool_call",
      { toolName: "set_thinking_level", toolCallId: "setter", input: {} },
      createCtx(),
    );
    await tools[0].execute(
      "setter",
      { level: "high", persist: false },
      undefined,
      undefined,
      createCtx(),
    );
    await emit("thinking_level_select", { level: "low", previousLevel: "high" }, createCtx());
    await emit("model_select", { model: { id: "other-model" } }, createCtx());
    await emit("agent_end", {}, createCtx());

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
      const { pi, tools, emit, handlers } = createPi();
      const ctx = createCtx({ cwd: project });
      adaptiveThinking(pi as never);
      await emit("session_start", { reason: "startup" }, ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "Adaptive Thinking configuration: systemPrompt is deprecated; rename it to guidance.",
        "warning",
      );
      expect(handlers.has("before_agent_start")).toBe(false);
      expect(tools[0].promptGuidelines).toContain("Legacy static guidance");
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  test("same-level tool call is a no-op", async () => {
    const { pi, tools, emit } = createPi();
    adaptiveThinking(pi as never);
    await emit("session_start", { reason: "startup" }, createCtx());

    const result = await tools[0].execute(
      "tool-call",
      { level: "medium", persist: false },
      undefined,
      undefined,
      createCtx(),
    );

    expect(result.content[0].text).toBe("Thinking level is already medium; no change made.");
    expect(pi.setThinkingLevel).not.toHaveBeenCalled();
  });

  test("setter uses native thinking level as its source of truth", async () => {
    const { pi, tools, emit } = createPi();
    adaptiveThinking(pi as never);
    await emit("session_start", { reason: "startup" }, createCtx());
    vi.mocked(pi.getThinkingLevel).mockReturnValue("high");

    const result = await tools[0].execute(
      "tool-call",
      { level: "high", persist: false },
      undefined,
      undefined,
      createCtx(),
    );

    expect(result.content[0].text).toBe("Thinking level is already high; no change made.");
    expect(pi.setThinkingLevel).not.toHaveBeenCalled();
  });

  test("temporary change fails when the Session Baseline is unknown", async () => {
    const { pi, tools, emit } = createPi();
    vi.mocked(pi.getThinkingLevel).mockReturnValue("turbo" as never);
    adaptiveThinking(pi as never);
    await emit("session_start", { reason: "startup" }, createCtx());

    const result = await tools[0].execute(
      "tool-call",
      { level: "high", persist: false },
      undefined,
      undefined,
      createCtx(),
    );

    expect(result.content[0].text).toBe(
      "Cannot apply a temporary thinking level because the Session Baseline is unknown.",
    );
    expect(pi.setThinkingLevel).not.toHaveBeenCalled();
  });

  test("back-to-back reasoning tool calls are no-ops", async () => {
    const { pi, tools, emit } = createPi();
    adaptiveThinking(pi as never);
    await emit("session_start", { reason: "startup" }, createCtx());

    await emit(
      "tool_call",
      { toolName: "set_thinking_level", toolCallId: "first", input: {} },
      createCtx(),
    );
    await tools[0].execute(
      "first",
      { level: "high", persist: false },
      undefined,
      undefined,
      createCtx(),
    );
    vi.mocked(pi.setThinkingLevel).mockClear();

    await emit(
      "tool_call",
      { toolName: "set_thinking_level", toolCallId: "second", input: {} },
      createCtx(),
    );
    const result = await tools[0].execute(
      "second",
      { level: "low", persist: false },
      undefined,
      undefined,
      createCtx(),
    );

    expect(result.content[0].text).toBe(
      "Thinking level change skipped because the previous tool call was also set_thinking_level. Reassess after another tool call or new user input.",
    );
    expect(pi.setThinkingLevel).not.toHaveBeenCalled();
  });

  test("status inspection allows a following thinking-level change", async () => {
    const { pi, tools, emit } = createPi();
    adaptiveThinking(pi as never);
    await emit("session_start", { reason: "startup" }, createCtx());

    await emit(
      "tool_call",
      { toolName: "get_thinking_level", toolCallId: "status", input: {} },
      createCtx(),
    );
    await tools[1].execute("status", {}, undefined, undefined, createCtx());
    await emit(
      "tool_call",
      { toolName: "set_thinking_level", toolCallId: "setter", input: {} },
      createCtx(),
    );
    const result = await tools[0].execute(
      "setter",
      { level: "high", persist: true },
      undefined,
      undefined,
      createCtx(),
    );

    expect(result.content[0].text).toBe("Thinking level set to high");
    expect(pi.setThinkingLevel).toHaveBeenCalledWith("high");
  });

  test("back-to-back state is tracked per tool call", async () => {
    const { pi, tools, emit } = createPi();
    adaptiveThinking(pi as never);
    await emit("session_start", { reason: "startup" }, createCtx());

    await emit(
      "tool_call",
      { toolName: "set_thinking_level", toolCallId: "first", input: {} },
      createCtx(),
    );
    await emit(
      "tool_call",
      { toolName: "set_thinking_level", toolCallId: "second", input: {} },
      createCtx(),
    );

    const firstResult = await tools[0].execute(
      "first",
      { level: "high", persist: false },
      undefined,
      undefined,
      createCtx(),
    );
    vi.mocked(pi.setThinkingLevel).mockClear();

    const secondResult = await tools[0].execute(
      "second",
      { level: "low", persist: false },
      undefined,
      undefined,
      createCtx(),
    );

    expect(firstResult.content[0].text).toBe("Thinking level set to high");
    expect(secondResult.content[0].text).toBe(
      "Thinking level change skipped because the previous tool call was also set_thinking_level. Reassess after another tool call or new user input.",
    );
    expect(pi.setThinkingLevel).not.toHaveBeenCalled();
  });

  test("intervening tool call allows another reasoning change", async () => {
    const { pi, tools, emit } = createPi();
    adaptiveThinking(pi as never);
    await emit("session_start", { reason: "startup" }, createCtx());

    await emit(
      "tool_call",
      { toolName: "set_thinking_level", toolCallId: "first", input: {} },
      createCtx(),
    );
    await tools[0].execute(
      "first",
      { level: "high", persist: true },
      undefined,
      undefined,
      createCtx(),
    );
    vi.mocked(pi.setThinkingLevel).mockClear();

    await emit(
      "tool_call",
      { toolName: "read", toolCallId: "read", input: { path: "src/index.ts" } },
      createCtx(),
    );
    await emit(
      "tool_call",
      { toolName: "set_thinking_level", toolCallId: "second", input: {} },
      createCtx(),
    );
    const result = await tools[0].execute(
      "second",
      { level: "low", persist: true },
      undefined,
      undefined,
      createCtx(),
    );

    expect(result.content[0].text).toBe("Thinking level set to low");
    expect(pi.setThinkingLevel).toHaveBeenCalledWith("low");
  });

  test("persistent tool call sets baseline and does not reset on agent_end", async () => {
    const { pi, tools, emit } = createPi();
    adaptiveThinking(pi as never);
    await emit("session_start", { reason: "startup" }, createCtx());

    const result = await tools[0].execute(
      "tool-call",
      { level: "high", persist: true },
      undefined,
      undefined,
      createCtx(),
    );

    expect(result.content[0].text).toBe("Thinking level set to high");
    expect(pi.setThinkingLevel).toHaveBeenCalledWith("high");

    vi.mocked(pi.setThinkingLevel).mockClear();
    await emit("agent_end", {}, createCtx());
    expect(pi.setThinkingLevel).not.toHaveBeenCalled();
  });

  test("persistent tool call does not update global default settings", async () => {
    const agentDir = join(tmpdir(), `pi-adaptive-thinking-${Date.now()}`);
    const settingsPath = join(agentDir, "settings.json");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({ defaultThinkingLevel: "max", theme: "dark" }));

    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;

    try {
      const { pi, tools, emit } = createPi();
      vi.mocked(pi.setThinkingLevel).mockImplementation((level: string) => {
        const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
        settings.defaultThinkingLevel = level;
        settings.theme = "light";
        writeFileSync(settingsPath, JSON.stringify(settings));
      });

      adaptiveThinking(pi as never);
      await emit("session_start", { reason: "startup" }, createCtx());

      await tools[0].execute(
        "tool-call",
        { level: "high", persist: true },
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
    const { pi, tools, emit } = createPi();
    adaptiveThinking(pi as never);
    await emit("session_start", { reason: "startup" }, createCtx());

    const result = await tools[0].execute(
      "tool-call",
      { level: "high", persist: false },
      undefined,
      undefined,
      createCtx(),
    );

    expect(result.content[0].text).toBe("Thinking level set to high");
    expect(pi.setThinkingLevel).toHaveBeenCalledWith("high");

    await emit("agent_end", {}, createCtx());
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
      const { pi, tools, emit } = createPi();
      vi.mocked(pi.setThinkingLevel).mockImplementation((level: string) => {
        const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
        settings.defaultThinkingLevel = level;
        settings.theme = "light";
        writeFileSync(settingsPath, JSON.stringify(settings));
      });

      adaptiveThinking(pi as never);
      await emit("session_start", { reason: "startup" }, createCtx());
      await tools[0].execute(
        "tool-call",
        { level: "high", persist: false },
        undefined,
        undefined,
        createCtx(),
      );
      expect(JSON.parse(readFileSync(settingsPath, "utf-8"))).toEqual({
        defaultThinkingLevel: "max",
        theme: "light",
      });

      await emit("agent_end", {}, createCtx());
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
    const { pi, tools, emit } = createPi();
    adaptiveThinking(pi as never);
    await emit("session_start", { reason: "startup" }, createCtx());
    vi.mocked(pi.getThinkingLevel).mockReturnValue("low");

    await tools[0].execute(
      "tool-call",
      { level: "high", persist: false },
      undefined,
      undefined,
      createCtx(),
    );
    await emit("agent_end", {}, createCtx());

    expect(pi.setThinkingLevel).toHaveBeenLastCalledWith("low");
  });

  test("retains native max selection as the temporary Session Baseline", async () => {
    const { pi, tools, emit } = createPi();
    adaptiveThinking(pi as never);
    await emit("session_start", { reason: "startup" }, createCtx());
    vi.mocked(pi.getThinkingLevel).mockReturnValue("max");

    await tools[0].execute(
      "tool-call",
      { level: "high", persist: false },
      undefined,
      undefined,
      createCtx(),
    );
    await emit("agent_end", {}, createCtx());

    expect(pi.setThinkingLevel).toHaveBeenLastCalledWith("max");
  });

  test("invalid level returns error and does not call setter", async () => {
    const { pi, tools, emit } = createPi();
    adaptiveThinking(pi as never);
    await emit("session_start", { reason: "startup" }, createCtx());

    const result = await tools[0].execute(
      "tool-call",
      { level: "turbo", persist: false },
      undefined,
      undefined,
      createCtx(),
    );

    expect(result.content[0].text).toContain("Invalid thinking level: turbo");
    expect(pi.setThinkingLevel).not.toHaveBeenCalled();
  });
});
