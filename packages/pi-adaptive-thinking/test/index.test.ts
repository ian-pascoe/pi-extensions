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

  return { pi, tools, emit };
};

const createCtx = (overrides: Partial<any> = {}) => ({
  cwd: "/tmp/project",
  hasUI: true,
  ui: { notify: vi.fn() },
  model: undefined,
  ...overrides,
});

describe("adaptiveThinking extension", () => {
  test("registers the default tool and injects prompt guidance", async () => {
    const { pi, tools, emit } = createPi();
    adaptiveThinking(pi as never);

    await emit("session_start", { reason: "startup" }, createCtx());

    expect(tools[0].name).toBe("set_thinking_level");

    const result = await emit(
      "before_agent_start",
      { prompt: "hello", systemPrompt: "Base prompt" },
      createCtx(),
    );

    expect(result.systemPrompt).toContain("Base prompt");
    expect(result.systemPrompt).toContain("manage thinking level actively");
    expect(result.systemPrompt).toContain("Current thinking level: medium");
    expect(result.systemPrompt).toContain(
      "Valid thinking levels for this session: off, minimal, low, medium, high, xhigh, max",
    );
    expect(result.systemPrompt).toContain("set_thinking_level");
    expect(result.systemPrompt).toContain(
      "Do not call set_thinking_level if the current thinking level already matches the target level",
    );
    expect(result.systemPrompt).toContain("Do not call set_thinking_level twice in a row");
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

  test("thinking_level_select updates cached current level", async () => {
    const { pi, tools, emit } = createPi();
    adaptiveThinking(pi as never);
    await emit("session_start", { reason: "startup" }, createCtx());
    await emit("thinking_level_select", { level: "low", previousLevel: "medium" }, createCtx());

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

  test("retains a Pi max selection as the temporary reset baseline", async () => {
    const { pi, tools, emit } = createPi();
    adaptiveThinking(pi as never);
    await emit("session_start", { reason: "startup" }, createCtx());
    await emit("thinking_level_select", { level: "max", previousLevel: "medium" }, createCtx());

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
