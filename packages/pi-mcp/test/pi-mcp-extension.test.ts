import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  DefaultResourceLoader,
  ExtensionRunner,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  type ContextEvent,
  type ExtensionCommandContext,
  type SessionShutdownEvent,
  type SessionStartEvent,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createPiMcpExtension, type PiMcpExtensionSession } from "../src/pi-mcp-extension.js";

const temporaryDirectories: string[] = [];
// SAFETY: The registered MCP message renderers use only fg, bg, and bold; this inert theme supplies those complete operations.
const plainTheme = {
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  fg: (_color: string, text: string) => text,
} as Theme;

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function createRunner(session?: PiMcpExtensionSession): Promise<ExtensionRunner> {
  const cwd = await temporaryDirectory("pi-mcp-extension-cwd-");
  const agentDirectory = await temporaryDirectory("pi-mcp-extension-agent-");
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDirectory);
  const sessionDirectory = await temporaryDirectory("pi-mcp-extension-session-");
  const sessionManager = SessionManager.create(cwd, sessionDirectory);
  const loader = new DefaultResourceLoader({
    agentDir: agentDirectory,
    cwd,
    extensionFactories: [
      {
        name: "pi-mcp-extension-test",
        factory: createPiMcpExtension(
          session === undefined ? undefined : { createSession: async () => session },
        ),
      },
    ],
    noContextFiles: true,
    noPromptTemplates: true,
    noSkills: true,
    noThemes: true,
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  expect(loaded.errors).toEqual([]);

  const runtime = await ModelRuntime.create({
    authPath: resolve(agentDirectory, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const runner = new ExtensionRunner(
    loaded.extensions,
    loaded.runtime,
    cwd,
    sessionManager,
    new ModelRegistry(runtime),
  );
  runner.bindCore(
    {
      appendEntry: (customType, data) => sessionManager.appendCustomEntry(customType, data),
      getActiveTools: () => [],
      getAllTools: () => [],
      getCommands: () => [],
      getSessionName: () => undefined,
      getThinkingLevel: () => "medium",
      refreshTools: () => undefined,
      sendMessage: () => undefined,
      sendUserMessage: () => undefined,
      setActiveTools: () => undefined,
      setLabel: () => undefined,
      setModel: async () => true,
      setSessionName: () => undefined,
      setThinkingLevel: () => undefined,
    },
    {
      abort: () => undefined,
      compact: () => undefined,
      getContextUsage: () => undefined,
      getModel: () => undefined,
      getScopedModels: () => [],
      getSignal: () => undefined,
      getSystemPrompt: () => "base",
      hasPendingMessages: () => false,
      isIdle: () => true,
      isProjectTrusted: () => true,
      shutdown: () => undefined,
    },
  );
  return runner;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("Pi MCP extension lifecycle", () => {
  test("forwards the complete MCP argument prefix through the registered command", async () => {
    const completeCommandArguments = vi.fn(async (_prefix: string) => [
      { description: "Reconnect an MCP Server", label: "reconnect", value: "reconnect " },
    ]);
    const session: PiMcpExtensionSession = {
      close: async () => undefined,
      completeCommandArguments,
      executeCommand: async () => ({ level: "info", message: "ok" }),
      instructionSnapshot: () => undefined,
      redactPresentationText: (text) => text,
      start: async () => undefined,
      transformContext: (messages) => messages,
    };
    const runner = await createRunner(session);
    await runner.emit({ type: "session_start", reason: "startup" } satisfies SessionStartEvent);

    await expect(runner.getCommand("mcp")?.getArgumentCompletions?.("rec")).resolves.toEqual([
      { description: "Reconnect an MCP Server", label: "reconnect", value: "reconnect " },
    ]);
    expect(completeCommandArguments).toHaveBeenCalledWith("rec");
  });

  test("reads current instructions at each agent start without blocking startup", async () => {
    let releaseStart: (() => void) | undefined;
    const startBlocked = new Promise<void>((resolveStart) => {
      releaseStart = resolveStart;
    });
    const closeReasons: string[] = [];
    let instructions: string | undefined;
    const instructionSnapshot = vi.fn(() => instructions);
    const session: PiMcpExtensionSession = {
      close: async (reason) => {
        closeReasons.push(reason);
      },
      executeCommand: async (_arguments: string, _context: ExtensionCommandContext) => ({
        level: "info",
        message: "ok",
      }),
      instructionSnapshot,
      redactPresentationText: (text) => text,
      start: () => startBlocked,
      transformContext: (messages) => messages,
    };
    const runner = await createRunner(session);

    const start = runner.emit({
      type: "session_start",
      reason: "startup",
    } satisfies SessionStartEvent);
    await expect(
      Promise.race([start.then(() => "started"), Promise.resolve("tick")]),
    ).resolves.toBe("tick");
    await expect(start).resolves.toBeUndefined();

    const promptContext = {
      selectedTools: [],
      toolSnippets: {},
      promptGuidelines: [],
      appendSystemPrompt: "",
      cwd: runner.createContext().cwd,
      contextFiles: [],
      skills: [],
    };
    const chainedPrompt = "base\n\nEarlier extension instructions";
    await expect(
      runner.emitBeforeAgentStart("first", undefined, chainedPrompt, promptContext),
    ).resolves.toBeUndefined();
    expect(instructionSnapshot).toHaveBeenCalledTimes(1);

    instructions = "Server Instructions\n- fixture: keep exact bytes";
    const history: ContextEvent["messages"] = [
      { role: "user", content: "Fixed input", timestamp: 1 },
    ];
    expect(await runner.emitContext(history)).toEqual(history);
    expect(await runner.emitContext(history)).toEqual(history);
    expect(instructionSnapshot).toHaveBeenCalledTimes(1);

    const nextStart = await runner.emitBeforeAgentStart(
      "second",
      undefined,
      chainedPrompt,
      promptContext,
    );
    expect(nextStart).toEqual({
      systemPrompt: `${chainedPrompt}\n\nServer Instructions\n- fixture: keep exact bytes`,
    });
    expect(
      await runner.emitBeforeAgentStart("unchanged", undefined, chainedPrompt, promptContext),
    ).toEqual(nextStart);
    expect(instructionSnapshot).toHaveBeenCalledTimes(3);

    instructions = "Changed Server Instructions";
    expect(await runner.emitContext(history)).toEqual(history);
    expect(instructionSnapshot).toHaveBeenCalledTimes(3);
    expect(nextStart?.systemPrompt).toBe(
      `${chainedPrompt}\n\nServer Instructions\n- fixture: keep exact bytes`,
    );
    expect(
      await runner.emitBeforeAgentStart("changed", undefined, chainedPrompt, promptContext),
    ).toEqual({ systemPrompt: `${chainedPrompt}\n\nChanged Server Instructions` });

    instructions = undefined;
    expect(await runner.emitContext(history)).toEqual(history);
    expect(instructionSnapshot).toHaveBeenCalledTimes(4);
    expect(
      await runner.emitBeforeAgentStart("removed", undefined, chainedPrompt, promptContext),
    ).toBeUndefined();
    expect(instructionSnapshot).toHaveBeenCalledTimes(5);

    releaseStart?.();
    await runner.emit({ type: "session_shutdown", reason: "quit" } satisfies SessionShutdownEvent);
    await runner.emit({ type: "session_shutdown", reason: "quit" } satisfies SessionShutdownEvent);
    expect(closeReasons).toEqual(["quit"]);
  });

  test("replays saved MCP Prompt expansion deterministically without consulting a Server", async () => {
    const runner = await createRunner();
    await runner.emit({ type: "session_start", reason: "startup" } satisfies SessionStartEvent);
    const history: ContextEvent["messages"] = [
      {
        role: "custom",
        customType: "pi-mcp-prompt",
        content: "MCP Prompt unavailable/review",
        display: true,
        timestamp: 1,
        details: {
          version: 1,
          mcpMessages: [
            { role: "user", content: { type: "text", text: "Unmapped protocol content" } },
          ],
          replayMessages: [
            { role: "user", content: [{ type: "text", text: "Saved expansion" }], timestamp: 1 },
            {
              role: "assistant",
              content: [{ type: "text", text: "Saved response" }],
              timestamp: 2,
            },
          ],
        },
      },
    ];
    const original = structuredClone(history);
    try {
      const first = await runner.emitContext(history);
      expect(first).toMatchObject([
        { role: "user", content: [{ type: "text", text: "Saved expansion" }], timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "Saved response" }], timestamp: 2 },
      ]);
      expect(await runner.emitContext(history)).toEqual(first);
      expect(await runner.emitContext(first)).toEqual(first);
      expect(history).toEqual(original);
    } finally {
      await runner.emit({
        type: "session_shutdown",
        reason: "quit",
      } satisfies SessionShutdownEvent);
    }
  });

  test.each(["reload", "new", "resume", "fork"] as const)(
    "releases clients for %s session replacement",
    async (reason) => {
      const close = vi.fn(async () => undefined);
      const session: PiMcpExtensionSession = {
        close,
        executeCommand: async () => ({ level: "info", message: "ok" }),
        instructionSnapshot: () => undefined,
        redactPresentationText: (text) => text,
        start: async () => undefined,
        transformContext: (messages) => messages,
      };
      const runner = await createRunner(session);
      await runner.emit({ type: "session_start", reason: "startup" } satisfies SessionStartEvent);

      await runner.emit({ type: "session_shutdown", reason } satisfies SessionShutdownEvent);

      expect(close).toHaveBeenCalledWith("handoff");
    },
  );

  test("yields one event-loop turn before background MCP startup", async () => {
    let started = false;
    const session: PiMcpExtensionSession = {
      close: async () => undefined,
      executeCommand: async () => ({ level: "info", message: "ok" }),
      instructionSnapshot: () => undefined,
      redactPresentationText: (text) => text,
      start: async () => {
        started = true;
      },
      transformContext: (messages) => messages,
    };
    const runner = await createRunner(session);

    await runner.emit({ type: "session_start", reason: "startup" } satisfies SessionStartEvent);
    expect(started).toBe(false);

    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
    expect(started).toBe(true);
  });

  test("starts MCP before an immediate first agent turn", async () => {
    let starts = 0;
    const session: PiMcpExtensionSession = {
      close: async () => undefined,
      executeCommand: async () => ({ level: "info", message: "ok" }),
      instructionSnapshot: () => {
        if (starts === 0) throw new Error("MCP startup was not initiated");
        return "Immediate instructions";
      },
      redactPresentationText: (text) => text,
      start: async () => {
        starts += 1;
      },
      transformContext: (messages) => messages,
    };
    const runner = await createRunner(session);
    await runner.emit({ type: "session_start", reason: "startup" } satisfies SessionStartEvent);

    const beforeStart = await runner.emitBeforeAgentStart("hello", undefined, "base", {
      selectedTools: [],
      toolSnippets: {},
      promptGuidelines: [],
      appendSystemPrompt: "",
      cwd: runner.createContext().cwd,
      contextFiles: [],
      skills: [],
    });

    expect(starts).toBe(1);
    expect(beforeStart?.systemPrompt).toBe("base\n\nImmediate instructions");
  });

  test("registers inert Prompt and Resource Update renderers with the active session redactor", async () => {
    const session: PiMcpExtensionSession = {
      close: async () => undefined,
      executeCommand: async () => ({ level: "info", message: "ok" }),
      instructionSnapshot: () => undefined,
      redactPresentationText: (text) => text.replaceAll("secret", "[REDACTED]"),
      start: async () => undefined,
      transformContext: (messages) => messages,
    };
    const runner = await createRunner(session);
    const promptRenderer = runner.getMessageRenderer("pi-mcp-prompt");
    const resourceRenderer = runner.getMessageRenderer("pi-mcp-resource-update");
    expect(promptRenderer).toEqual(expect.any(Function));
    expect(resourceRenderer).toEqual(expect.any(Function));

    await runner.emit({ type: "session_start", reason: "startup" } satisfies SessionStartEvent);
    const prompt = {
      content: "MCP Prompt docs/review",
      customType: "pi-mcp-prompt",
      details: {
        mcpMessages: [],
        replayMessages: [
          {
            content: [{ text: "secret body", type: "text" as const }],
            role: "user" as const,
            timestamp: 1,
          },
        ],
        version: 1 as const,
      },
      display: true,
      role: "custom" as const,
      timestamp: 1,
    };
    const before = structuredClone(prompt);
    const renderedPrompt = promptRenderer?.(prompt, { expanded: true, outputPad: 1 }, plainTheme);
    expect(renderedPrompt?.render(120).join("\n")).toContain("[REDACTED] body");
    expect(prompt).toEqual(before);

    const renderedUpdate = resourceRenderer?.(
      {
        content:
          "MCP Resource updated on docs: file:///secret. Read it explicitly before using the new content.",
        customType: "pi-mcp-resource-update",
        display: true,
        role: "custom",
        timestamp: 1,
      },
      { expanded: true, outputPad: 1 },
      plainTheme,
    );
    expect(renderedUpdate?.render(120).join("\n")).toContain(
      "The Resource remains unread until the agent explicitly reads it.",
    );
    expect(renderedUpdate?.render(120).join("\n")).not.toContain("secret");
  });
});
