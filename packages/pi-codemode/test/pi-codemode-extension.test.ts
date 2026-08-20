import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import {
  AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionUIContext,
  initTheme,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterEach, describe, expect, test } from "vitest";
import {
  CodeModeResultDetailsSchema,
  CodeModeResultSchema,
  type CodeModeJsonValue,
  type CodeModeResult,
} from "../src/codemode-tool-contract.js";
import piCodeModeExtension from "../src/pi-codemode-extension.js";

const fixtureDirectories: string[] = [];
const fixtureSessions: AgentSession[] = [];

function nestedUsage(units: number): Usage {
  return {
    input: units,
    output: units,
    cacheRead: units,
    cacheWrite: units,
    totalTokens: units * 4,
    cost: {
      input: units,
      output: units,
      cacheRead: units,
      cacheWrite: units,
      total: units * 4,
    },
  };
}

type CodeModeExtensionFixture = {
  readonly extensionApi: ExtensionAPI;
  readonly notifications: string[];
  readonly registerDynamicTool: (description?: string) => void;
  readonly session: AgentSession;
};

type CodeModeSettingsTestInput = {
  readonly maxSessions?: number;
  readonly tools?: readonly {
    readonly pattern: string;
    readonly exposure: "codemode-only" | "direct-and-codemode" | "direct-only";
  }[];
};

async function createCodeModeExtensionFixture(
  codemodeSettings?: CodeModeSettingsTestInput,
  bind = true,
): Promise<CodeModeExtensionFixture> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-codemode-extension-cwd-"));
  const agentDirectory = await mkdtemp(join(tmpdir(), "pi-codemode-extension-agent-"));
  fixtureDirectories.push(cwd, agentDirectory);
  await mkdir(join(cwd, ".pi"));
  await writeFile(join(cwd, ".pi/settings.json"), "{}");
  await writeFile(
    join(agentDirectory, "settings.json"),
    JSON.stringify(codemodeSettings === undefined ? {} : { codemode: codemodeSettings }),
  );

  let extensionApi: ExtensionAPI | undefined;
  const registerClosureTool = (pi: ExtensionAPI): void => {
    pi.registerTool({
      name: "closure_echo",
      label: "Closure Echo",
      description: "Returns a distinctive registered extension closure.",
      parameters: Type.Object({ value: Type.Number() }, { additionalProperties: false }),
      async execute(_toolCallId, input, _signal, onUpdate) {
        onUpdate?.({
          content: [{ type: "text", text: "nested update" }],
          details: { nested: true },
        });
        return {
          content: [{ type: "text", text: `registered-closure:${input.value}` }],
          details: { closure: "registered-closure", value: input.value },
          usage: nestedUsage(1),
          addedToolNames: ["closure_echo"],
        };
      },
    });
    pi.registerTool({
      name: "hide_dynamic",
      label: "Hide Dynamic",
      description: "Removes the later tool from Pi's requested active set.",
      parameters: Type.Object({}, { additionalProperties: false }),
      executionMode: "sequential",
      async execute() {
        pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "dynamic_later"));
        return { content: [{ type: "text", text: "hidden" }], details: {} };
      },
    });
    pi.registerTool({
      name: "terminate_nested",
      label: "Terminate Nested",
      description: "Returns a terminating nested Pi result.",
      parameters: Type.Object({}, { additionalProperties: false }),
      executionMode: "sequential",
      async execute() {
        return {
          content: [{ type: "text", text: "terminate nested session" }],
          details: {},
          usage: nestedUsage(2),
          terminate: true,
        };
      },
    });
    pi.registerTool({
      name: "undefined_details",
      label: "Undefined Details",
      description: "Returns optional undefined fields in otherwise JSON-safe details.",
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute() {
        return {
          content: [{ type: "text", text: "undefined details" }],
          details: {
            kept: true,
            omitted: undefined,
            nested: { value: 42, omitted: undefined },
            values: [1, undefined, 3],
          },
        };
      },
    });
  };
  const extensionFactory = (pi: ExtensionAPI): void => {
    extensionApi = pi;
    registerClosureTool(pi);
  };
  const settingsManager = SettingsManager.create(cwd, agentDirectory, {
    projectTrusted: true,
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: agentDirectory,
    settingsManager,
    extensionFactories: [extensionFactory, piCodeModeExtension],
    noContextFiles: true,
    noPromptTemplates: true,
    noSkills: true,
    noThemes: true,
  });
  await resourceLoader.reload();
  const model = getModel("anthropic", "claude-sonnet-4-5");
  if (model === undefined) throw new Error("Pi CodeMode extension test: missing pinned model");
  const session = (
    await createAgentSession({
      cwd,
      agentDir: agentDirectory,
      model,
      resourceLoader,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager,
    })
  ).session;
  fixtureSessions.push(session);
  if (extensionApi === undefined) {
    throw new Error("Pi CodeMode extension test: companion ExtensionAPI was not created");
  }

  const notifications: string[] = [];
  if (bind) {
    await session.bindExtensions({
      mode: "rpc",
      uiContext: {
        ...session.extensionRunner.getUIContext(),
        notify: (message) => notifications.push(message),
      },
    });
  }
  const activeExtensionApi = extensionApi;
  return {
    extensionApi: activeExtensionApi,
    notifications,
    registerDynamicTool(description = "Dynamically registered after startup.") {
      activeExtensionApi.registerTool({
        name: "dynamic_later",
        label: "Dynamic Later",
        description,
        parameters: Type.Object({ text: Type.String() }, { additionalProperties: false }),
        async execute(_toolCallId, input) {
          return { content: [{ type: "text", text: input.text }], details: { dynamic: true } };
        },
      });
    },
    session,
  };
}

function activeTool(session: AgentSession, name: string): AgentTool {
  const tool = session.agent.state.tools.find((candidate) => candidate.name === name);
  if (tool === undefined)
    throw new Error(`Pi CodeMode extension test: missing active tool ${name}`);
  return tool;
}

async function executeTool(
  session: AgentSession,
  name: string,
  input: Record<string, CodeModeJsonValue>,
  onUpdate?: (result: AgentToolResult<unknown>) => void,
): Promise<AgentToolResult<unknown>> {
  return activeTool(session, name).execute(
    `test-${name}`,
    input,
    new AbortController().signal,
    onUpdate,
  );
}

function codeModeResult(result: AgentToolResult<unknown>): CodeModeResult {
  if (!Value.Check(CodeModeResultDetailsSchema, result.details)) {
    throw new Error(
      `Pi CodeMode extension test: invalid details ${JSON.stringify(result.details)}`,
    );
  }
  const { presentation: _presentation, ...publicResult } = result.details;
  if (!Value.Check(CodeModeResultSchema, publicResult)) {
    throw new Error(
      `Pi CodeMode extension test: invalid public result ${JSON.stringify(publicResult)}`,
    );
  }
  expect(result.content).toEqual([{ type: "text", text: JSON.stringify(publicResult) }]);
  return publicResult;
}

async function pollCodeModeSession(
  session: AgentSession,
  sessionId: string,
): Promise<AgentToolResult<unknown>> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await executeTool(session, "codemode_result", { sessionId });
    if (codeModeResult(result).result !== "pending") return result;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error(`Pi CodeMode extension test: session ${sessionId} remained pending`);
}

async function readResultSpill(path: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return await readFile(path, "utf8");
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    }
  }
  throw new Error(`Pi CodeMode extension test: Result Spill was not written: ${path}`);
}

function codeModeToolNames(session: AgentSession): string[] {
  return session
    .getAllTools()
    .map(({ name }) => name)
    .filter((name) => name.startsWith("codemode_"));
}

function executeDescription(session: AgentSession): string {
  const info = session.getAllTools().find(({ name }) => name === "codemode_execute");
  if (info === undefined) throw new Error("Pi CodeMode extension test: execute definition missing");
  return info.description;
}

afterEach(async () => {
  for (const session of fixtureSessions.splice(0)) {
    try {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    } finally {
      session.dispose();
    }
  }
  await Promise.all(
    fixtureDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Pi CodeMode extension", () => {
  test("keeps loading inert, then composes registered Pi tools through a reusable CodeMode Session", async () => {
    const fixture = await createCodeModeExtensionFixture(
      {
        tools: [{ pattern: "closure_echo", exposure: "codemode-only" }],
      },
      false,
    );

    expect(codeModeToolNames(fixture.session)).toEqual([]);
    await fixture.session.bindExtensions({
      mode: "rpc",
      uiContext: {
        ...fixture.session.extensionRunner.getUIContext(),
        notify: (message) => fixture.notifications.push(message),
      },
    });

    expect(codeModeToolNames(fixture.session)).toEqual([
      "codemode_execute",
      "codemode_result",
      "codemode_cancel",
    ]);
    const executeDefinition = fixture.session.getToolDefinition("codemode_execute");
    expect(executeDefinition?.renderCall).toEqual(expect.any(Function));
    expect(executeDefinition?.renderResult).toEqual(expect.any(Function));
    expect(fixture.session.getActiveToolNames()).not.toContain("closure_echo");
    expect(executeDescription(fixture.session)).toContain('readonly ["closure_echo"]');

    const started = await executeTool(fixture.session, "codemode_execute", {
      script: "type Count = number; let value: Count = 2; return value;",
      wait: false,
    });
    const pending = codeModeResult(started);
    expect(pending.result).toBe("pending");
    const first = await pollCodeModeSession(fixture.session, pending.sessionId);
    expect(codeModeResult(first)).toEqual({
      result: "success",
      sessionId: pending.sessionId,
      data: 2,
    });

    const updates: AgentToolResult<unknown>[] = [];
    const reused = await executeTool(
      fixture.session,
      "codemode_execute",
      {
        script:
          "value += 3; const nested = await tools.closure_echo({ value }); return { nested, value };",
        sessionId: pending.sessionId,
        wait: true,
      },
      (update) => updates.push(update),
    );
    expect(codeModeResult(reused)).toEqual({
      result: "success",
      sessionId: pending.sessionId,
      data: {
        nested: {
          content: [{ type: "text", text: "registered-closure:5" }],
          details: { closure: "registered-closure", value: 5 },
        },
        value: 5,
      },
    });
    expect(reused.usage).toEqual(nestedUsage(1));
    expect(reused.addedToolNames).toEqual(["closure_echo"]);
    expect(reused.details).toMatchObject({
      presentation: {
        cell_ordinal: 2,
        nested_tool_count: 1,
        nested_tools: [{ name: "closure_echo", outcome: "success" }],
      },
    });
    expect(updates).toHaveLength(3);
    for (const update of updates) {
      expect(codeModeResult(update)).toEqual({
        result: "pending",
        sessionId: pending.sessionId,
      });
    }
    expect(updates[1]?.details).toMatchObject({
      presentation: { active_tool_names: ["closure_echo"], active_tool_count: 1 },
    });
    expect(updates[2]?.details).toMatchObject({
      presentation: { active_tool_names: [], nested_tool_count: 1 },
    });

    const cancelled = await executeTool(fixture.session, "codemode_cancel", {
      sessionId: pending.sessionId,
    });
    expect(codeModeResult(cancelled)).toEqual({
      result: "success",
      sessionId: pending.sessionId,
    });
    const terminal = await executeTool(fixture.session, "codemode_result", {
      sessionId: pending.sessionId,
    });
    expect(codeModeResult(terminal)).toMatchObject({
      result: "failed",
      sessionId: pending.sessionId,
      error: { code: "cancellation" },
    });
  }, 20_000);

  test("keeps model content complete while writing oversized presentation data to a Result Spill", async () => {
    const fixture = await createCodeModeExtensionFixture({}, false);
    await fixture.session.bindExtensions({ mode: "rpc" });
    const data = "x".repeat(60 * 1024);

    const result = await executeTool(fixture.session, "codemode_execute", {
      script: `"x".repeat(${data.length})`,
      wait: true,
    });

    expect(codeModeResult(result)).toMatchObject({ result: "success", data });
    if (!Value.Check(CodeModeResultDetailsSchema, result.details)) {
      throw new Error("Pi CodeMode extension test: missing Result Spill details");
    }
    const spillPath = result.details.presentation?.spill_path;
    if (spillPath === undefined) {
      throw new Error("Pi CodeMode extension test: missing Result Spill path");
    }
    expect(await readResultSpill(spillPath)).toBe(JSON.stringify(data, undefined, 2));
  }, 30_000);

  test("bridges registered tool results with optional undefined detail fields", async () => {
    const fixture = await createCodeModeExtensionFixture();

    const result = await executeTool(fixture.session, "codemode_execute", {
      script: "await tools.undefined_details({})",
      wait: true,
    });

    expect(codeModeResult(result)).toMatchObject({
      result: "success",
      data: {
        content: [{ type: "text", text: "undefined details" }],
        details: { kept: true, nested: { value: 42 }, values: [1, null, 3] },
      },
    });
  }, 20_000);

  test("mounts the read-only Observer only after TUI Cell activity", async () => {
    initTheme("dark");
    const fixture = await createCodeModeExtensionFixture({}, false);
    type ObserverWidgetFactory = Exclude<Parameters<ExtensionUIContext["setWidget"]>[1], undefined>;
    const widgetEvents: Array<{
      readonly content: ObserverWidgetFactory | undefined;
      readonly placement?: string;
    }> = [];
    const statusEvents: Array<string | undefined> = [];
    const setWidget = (
      _key: string,
      content: ObserverWidgetFactory | undefined,
      options?: { readonly placement?: string },
    ): void => {
      widgetEvents.push(
        options?.placement === undefined ? { content } : { content, placement: options.placement },
      );
    };
    // SAFETY: The Observer installs only component factories, matching the selected setWidget overload recorded above.
    const recordWidget = setWidget as ExtensionUIContext["setWidget"];
    await fixture.session.bindExtensions({
      mode: "tui",
      uiContext: {
        ...fixture.session.extensionRunner.getUIContext(),
        setStatus: (_key, text) => statusEvents.push(text),
        setWidget: recordWidget,
      },
    });
    expect(widgetEvents).toEqual([]);
    expect(statusEvents).toEqual([]);

    const started = await executeTool(fixture.session, "codemode_execute", {
      script: "while (true) {}",
      wait: false,
    });
    const pending = codeModeResult(started);
    expect(widgetEvents).toContainEqual({
      content: expect.any(Function),
      placement: "aboveEditor",
    });
    expect(stripTerminalSequences(statusEvents.at(-1) ?? "")).toContain("1 running · 1 live");

    await executeTool(fixture.session, "codemode_cancel", { sessionId: pending.sessionId });
    expect(statusEvents.at(-1)).toBeUndefined();
  }, 30_000);

  test("keeps direct exposure, guest exposure, and the dynamic catalogue coherent", async () => {
    const fixture = await createCodeModeExtensionFixture();
    expect(executeDescription(fixture.session)).not.toContain('readonly ["dynamic_later"]');

    fixture.registerDynamicTool("First dynamic catalogue description.");
    expect(fixture.session.getActiveToolNames()).toContain("dynamic_later");
    expect(executeDescription(fixture.session)).toContain('readonly ["dynamic_later"]');
    expect(executeDescription(fixture.session)).toContain("First dynamic catalogue description.");

    const created = await executeTool(fixture.session, "codemode_execute", {
      script:
        'const savedDynamic = tools.dynamic_later; return Object.keys(tools).includes("dynamic_later");',
      wait: true,
    });
    const createdDetails = codeModeResult(created);
    expect(createdDetails).toMatchObject({ result: "success", data: true });

    fixture.registerDynamicTool("Replacement dynamic catalogue description.");
    expect(executeDescription(fixture.session)).toContain(
      "Replacement dynamic catalogue description.",
    );
    const changedMidBatch = await executeTool(fixture.session, "codemode_execute", {
      script:
        'const outcomes = await Promise.all([tools.hide_dynamic({}), tools.dynamic_later({ text: "must not run" }).then(() => "ran", (error) => error.code)]); return outcomes[1];',
      sessionId: createdDetails.sessionId,
      wait: true,
    });
    expect(codeModeResult(changedMidBatch)).toMatchObject({
      result: "success",
      data: "unknown-tool",
    });
    await fixture.session.extensionRunner.emitBeforeAgentStart("synchronize", undefined, "test", {
      cwd: ".",
    });

    expect(fixture.session.getActiveToolNames()).not.toContain("dynamic_later");
    expect(executeDescription(fixture.session)).not.toContain('readonly ["dynamic_later"]');
    expect(fixture.session.getActiveToolNames()).toEqual(
      expect.arrayContaining(["codemode_execute", "codemode_result", "codemode_cancel"]),
    );

    const hidden = await executeTool(fixture.session, "codemode_execute", {
      script:
        'try { await savedDynamic({ text: "must not run" }); return "unexpected"; } catch (error) { return { code: error.code, name: error.name }; }',
      sessionId: createdDetails.sessionId,
      wait: true,
    });
    expect(codeModeResult(hidden)).toMatchObject({
      result: "success",
      data: { code: "unknown-tool", name: "CodeModeToolError" },
    });
  }, 20_000);

  test("fails closed without registering tools or changing active names for invalid settings", async () => {
    const fixture = await createCodeModeExtensionFixture({ maxSessions: 0 }, false);
    const activeNames = fixture.session.getActiveToolNames();

    await fixture.session.bindExtensions({
      mode: "rpc",
      uiContext: {
        ...fixture.session.extensionRunner.getUIContext(),
        notify: (message) => fixture.notifications.push(message),
      },
    });

    expect(codeModeToolNames(fixture.session)).toEqual([]);
    expect(fixture.session.getActiveToolNames()).toEqual(activeNames);
    expect(fixture.notifications).toEqual([
      "Pi CodeMode disabled: global codemode.maxSessions: expected a positive safe integer",
    ]);
  });

  test("fails closed when the pinned AgentSession capability shape is unavailable", async () => {
    const fixture = await createCodeModeExtensionFixture(undefined, false);
    const activeNames = fixture.session.getActiveToolNames();
    const descriptor = Object.getOwnPropertyDescriptor(AgentSession.prototype, "getAllTools");
    if (descriptor === undefined)
      throw new Error("Pi CodeMode extension test: missing getAllTools descriptor");
    Object.defineProperty(AgentSession.prototype, "getAllTools", {
      ...descriptor,
      value: undefined,
    });
    try {
      await fixture.session.bindExtensions({
        mode: "rpc",
        uiContext: {
          ...fixture.session.extensionRunner.getUIContext(),
          notify: (message) => fixture.notifications.push(message),
        },
      });
    } finally {
      Object.defineProperty(AgentSession.prototype, "getAllTools", descriptor);
    }

    expect(codeModeToolNames(fixture.session)).toEqual([]);
    expect(fixture.session.getActiveToolNames()).toEqual(activeNames);
    expect(fixture.notifications).toEqual([
      "Pi CodeMode disabled: AgentSession.getAllTools is not the tested data method",
    ]);
  });

  test("enforces maxSessions and makes timeout and nested termination fatal", async () => {
    const fixture = await createCodeModeExtensionFixture({ maxSessions: 1 });
    const hanging = await executeTool(fixture.session, "codemode_execute", {
      script: "await new Promise(() => {});",
      wait: false,
    });
    const hangingDetails = codeModeResult(hanging);
    expect(hangingDetails.result).toBe("pending");

    const capacity = await executeTool(fixture.session, "codemode_execute", {
      script: "return 1;",
      wait: true,
    });
    expect(codeModeResult(capacity)).toMatchObject({
      result: "failed",
      error: { code: "capacity" },
    });
    await executeTool(fixture.session, "codemode_cancel", {
      sessionId: hangingDetails.sessionId,
    });

    const timedOut = await executeTool(fixture.session, "codemode_execute", {
      script: "while (true) {}",
      timeoutMs: 20,
      wait: true,
    });
    expect(codeModeResult(timedOut)).toMatchObject({
      result: "failed",
      error: { code: "timeout" },
    });

    const terminated = await executeTool(fixture.session, "codemode_execute", {
      script: "await tools.terminate_nested({}); return 'unreachable';",
      wait: true,
    });
    expect(codeModeResult(terminated)).toMatchObject({
      result: "failed",
      error: { code: "termination" },
    });
    expect(terminated.terminate).toBe(true);
    expect(terminated.usage).toEqual(nestedUsage(2));
  }, 30_000);

  test("tears down the prior generation on reload and restores the active-set method on shutdown", async () => {
    const fixture = await createCodeModeExtensionFixture();
    const hanging = codeModeResult(
      await executeTool(fixture.session, "codemode_execute", {
        script: "await new Promise(() => {});",
        wait: false,
      }),
    );
    expect(Object.hasOwn(fixture.session, "setActiveToolsByName")).toBe(true);

    let restoredBeforeRestart = false;
    await fixture.session.reload({
      beforeSessionStart: () => {
        restoredBeforeRestart = !Object.hasOwn(fixture.session, "setActiveToolsByName");
      },
    });
    expect(restoredBeforeRestart).toBe(true);
    expect(Object.hasOwn(fixture.session, "setActiveToolsByName")).toBe(true);
    expect(codeModeToolNames(fixture.session)).toEqual([
      "codemode_execute",
      "codemode_result",
      "codemode_cancel",
    ]);
    const stale = await executeTool(fixture.session, "codemode_result", {
      sessionId: hanging.sessionId,
    });
    expect(codeModeResult(stale)).toMatchObject({
      result: "failed",
      error: { code: "unknown" },
    });

    await fixture.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    expect(Object.hasOwn(fixture.session, "setActiveToolsByName")).toBe(false);
    const inactive = await executeTool(fixture.session, "codemode_execute", {
      script: "return 1;",
      wait: true,
    });
    expect(codeModeResult(inactive)).toMatchObject({
      result: "failed",
      error: { code: "runtime" },
    });
  }, 30_000);
});
