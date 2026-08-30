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
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterEach, describe, expect, test } from "vitest";
import {
  CodeModeResultDetailsSchema,
  CodeModeResultSchema,
  CodeModeSessionsResultSchema,
  CodeModeToolSearchPageSchema,
  type CodeModeJsonValue,
  type CodeModeResult,
  type CodeModeSessionsResult,
  type CodeModeToolSearchPage,
} from "../src/codemode-tool-contract.js";
import piCodeModeExtension from "../src/pi-codemode-extension.js";

const fixtureDirectories: string[] = [];
const fixtureSessions: AgentSession[] = [];
const ClosureEchoParametersSchema = Type.Object(
  { value: Type.Number() },
  { additionalProperties: false },
);
const ClosureEchoOutputSchema = Type.Object(
  { closure: Type.Literal("registered-closure"), value: Type.Number() },
  { additionalProperties: false },
);
const DynamicLaterParametersSchema = Type.Object(
  { text: Type.String() },
  { additionalProperties: false },
);
const DynamicLaterOutputSchema = Type.Object(
  { dynamic: Type.Literal(true) },
  { additionalProperties: false },
);

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
    const closureEchoTool: ToolDefinition<typeof ClosureEchoParametersSchema, unknown> & {
      readonly outputSchema: typeof ClosureEchoOutputSchema;
    } = {
      name: "closure_echo",
      label: "Closure Echo",
      description: "Returns a distinctive registered extension closure.",
      parameters: ClosureEchoParametersSchema,
      outputSchema: ClosureEchoOutputSchema,
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
    };
    pi.registerTool(closureEchoTool);
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
      const dynamicTool: ToolDefinition<typeof DynamicLaterParametersSchema, { dynamic: true }> & {
        readonly outputSchema: typeof DynamicLaterOutputSchema;
      } = {
        name: "dynamic_later",
        label: "Dynamic Later",
        description,
        parameters: DynamicLaterParametersSchema,
        outputSchema: DynamicLaterOutputSchema,
        async execute(_toolCallId, input) {
          return { content: [{ type: "text", text: input.text }], details: { dynamic: true } };
        },
      };
      activeExtensionApi.registerTool(dynamicTool);
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

function codeModeSessionsResult(result: AgentToolResult<unknown>): CodeModeSessionsResult {
  if (!Value.Check(CodeModeSessionsResultSchema, result.details)) {
    throw new Error(
      `Pi CodeMode extension test: invalid Session list ${JSON.stringify(result.details)}`,
    );
  }
  expect(result.content).toEqual([{ type: "text", text: JSON.stringify(result.details) }]);
  return result.details;
}

function codeModeToolSearchPage(result: AgentToolResult<unknown>): CodeModeToolSearchPage {
  if (!Value.Check(CodeModeToolSearchPageSchema, result.details)) {
    throw new Error(
      `Pi CodeMode extension test: invalid tool search page ${JSON.stringify(result.details)}`,
    );
  }
  expect(result.content).toEqual([{ type: "text", text: JSON.stringify(result.details) }]);
  return result.details;
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
      "codemode_sessions",
      "codemode_search",
    ]);
    const executeDefinition = fixture.session.getToolDefinition("codemode_execute");
    const searchDefinition = fixture.session.getToolDefinition("codemode_search");
    expect(executeDefinition?.renderCall).toEqual(expect.any(Function));
    expect(executeDefinition?.renderResult).toEqual(expect.any(Function));
    expect(searchDefinition?.renderCall).toEqual(expect.any(Function));
    expect(searchDefinition?.renderResult).toEqual(expect.any(Function));
    expect(Object.getOwnPropertyDescriptor(searchDefinition ?? {}, "outputSchema")?.value).toBe(
      CodeModeToolSearchPageSchema,
    );
    expect(fixture.session.systemPrompt).toContain(
      "- codemode_execute: Batch, filter, and aggregate Pi tool calls in TypeScript with less latency and context usage.",
    );
    expect(fixture.session.systemPrompt).toContain(
      "- Prefer codemode_execute when multiple Pi tool calls can be filtered, joined, aggregated, paginated, or used to drive later calls, or when one large result can be reduced before returning. Use direct parallel calls for a few small results needed verbatim.",
    );
    expect(fixture.session.systemPrompt).toContain(
      "- Return only decision-relevant CodeMode data while preserving paths, line numbers, IDs, URLs, source names, and concise evidence needed for verification.",
    );
    expect(fixture.session.systemPrompt).toContain(
      "- Reuse a CodeMode Session for related work. Prefer direct tools for simple one-off calls, full raw output, and confirmation-sensitive or destructive actions; use CodeMode mutations only when conditional sequencing is the point, and fall back to direct tools when the CodeMode boundary does not fit.",
    );
    expect(fixture.session.getActiveToolNames()).not.toContain("closure_echo");
    expect(executeDescription(fixture.session)).toContain('readonly ["codemode_search"]');
    expect(executeDescription(fixture.session)).toMatch(
      /CodeMode tool catalogue: (?:COMPLETE|PARTIAL)/,
    );
    expect(
      codeModeToolSearchPage(
        await executeTool(fixture.session, "codemode_search", { query: "closure_echo" }),
      ),
    ).toMatchObject({
      total: 1,
      items: [
        {
          name: "closure_echo",
          description: "Returns a distinctive registered extension closure.",
          declaration: expect.stringContaining('readonly ["closure_echo"]'),
        },
      ],
    });
    expect(
      codeModeSessionsResult(await executeTool(fixture.session, "codemode_sessions", {})).sessions,
    ).toEqual([]);
    expect(
      executeDescription(fixture.session).split("\n\nCurrent CodeMode tool declarations:")[0],
    ).toBe(
      "Execute a TypeScript Cell in a persistent isolated Deno CodeMode Session. Reuse a Session ID to retain Notebook Bindings; a new Session reclaims the least-recently-used idle Session at capacity. Use the read-only tools object for registered Pi tools. Return final result data with a top-level return statement. Reserve console.log, console.info, console.warn, console.error, and console.debug for diagnostics; captured output arrives only with terminal results.",
    );

    const started = await executeTool(fixture.session, "codemode_execute", {
      script:
        'type Count = number; let value: Count = 2; const [closure, read, write] = await Promise.all([tools.codemode_search({ query: "closure_echo" }), tools.codemode_search({ query: "read" }), tools.codemode_search({ query: "write" })]); console.log("value:", value); return { value, hasSearch: Object.keys(tools).includes("codemode_search"), closure: closure.items[0], readDeclaration: read.items[0]?.declaration, writeDeclaration: write.items[0]?.declaration };',
      wait: false,
    });
    const pending = codeModeResult(started);
    expect(pending.result).toBe("pending");
    const first = await pollCodeModeSession(fixture.session, pending.sessionId);
    expect(codeModeResult(first)).toMatchObject({
      result: "success",
      sessionId: pending.sessionId,
      data: {
        value: 2,
        hasSearch: true,
        closure: {
          name: "closure_echo",
          description: "Returns a distinctive registered extension closure.",
        },
      },
      console: [{ method: "log", text: "value: 2" }],
    });
    expect(JSON.stringify(codeModeResult(first))).toContain(
      'Promise<PiToolResult<{ readonly [\\"closure\\"]: \\"registered-closure\\"; readonly [\\"value\\"]: number; }>>',
    );
    expect(JSON.stringify(codeModeResult(first))).toMatch(
      /readonly \[\\"read\\"\]: .*Promise<PiToolResult<\{ readonly \[\\"truncation\\"\]\?: \{/,
    );
    expect(JSON.stringify(codeModeResult(first))).toMatch(
      /readonly \[\\"write\\"\]: .*Promise<PiToolResult<undefined>>;/,
    );
    expect(first.details).toMatchObject({
      presentation: { nested_tool_count: 0, nested_tools: [] },
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

    const invalidSearch = await executeTool(fixture.session, "codemode_execute", {
      script:
        'try { await tools.codemode_search({ limit: 0 }); return "unexpected"; } catch (error) { return { code: error.code, name: error.name }; }',
      sessionId: pending.sessionId,
      wait: true,
    });
    expect(codeModeResult(invalidSearch)).toMatchObject({
      result: "success",
      data: { code: "validation", name: "CodeModeToolError" },
    });
    expect(invalidSearch.details).toMatchObject({
      presentation: { nested_tool_count: 0, nested_tools: [] },
    });

    const excessiveSearch = await executeTool(fixture.session, "codemode_execute", {
      script:
        'try { await Promise.all(Array.from({ length: 21 }, () => tools.codemode_search({ query: "read" }))); return "unexpected"; } catch (error) { return { code: error.code, name: error.name }; }',
      sessionId: pending.sessionId,
      wait: true,
    });
    expect(codeModeResult(excessiveSearch)).toMatchObject({
      result: "success",
      data: { code: "validation", name: "CodeModeToolError" },
    });
    expect(excessiveSearch.details).toMatchObject({
      presentation: { nested_tool_count: 0, nested_tools: [] },
    });

    const failed = await executeTool(fixture.session, "codemode_execute", {
      script: 'console.warn("before failure"); throw new Error("failed")',
      sessionId: pending.sessionId,
      wait: true,
    });
    expect(codeModeResult(failed)).toMatchObject({
      result: "failed",
      sessionId: pending.sessionId,
      error: { code: "script" },
      console: [{ method: "warn", text: "before failure" }],
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

  test("searches and calls a tool omitted from a partial inline catalogue", async () => {
    const fixture = await createCodeModeExtensionFixture();
    const largeParameters = Type.Object(
      Object.fromEntries(
        Array.from({ length: 120 }, (_, index) => [
          `field_${String(index).padStart(3, "0")}`,
          Type.Optional(Type.String()),
        ]),
      ),
      { additionalProperties: false },
    );
    for (let index = 0; index < 12; index += 1) {
      const name = `large_catalog_tool_${String(index).padStart(2, "0")}`;
      fixture.extensionApi.registerTool({
        name,
        label: name,
        description: `Large catalogue integration tool ${index}.`,
        parameters: largeParameters,
        async execute() {
          return {
            content: [{ type: "text", text: `called:${name}` }],
            details: { name },
          };
        },
      });
    }

    const targetName = "large_catalog_tool_11";
    const description = executeDescription(fixture.session);
    expect(description).toContain("CodeMode tool catalogue: PARTIAL");
    expect(description).not.toContain(`readonly [${JSON.stringify(targetName)}]`);

    const result = await executeTool(fixture.session, "codemode_execute", {
      script: `const page = await tools.codemode_search({ query: ${JSON.stringify(targetName)} }); const called = await tools[${JSON.stringify(targetName)}]({}); return { item: page.items[0], called };`,
      wait: true,
    });
    expect(codeModeResult(result)).toMatchObject({
      result: "success",
      data: {
        item: {
          name: targetName,
          description: "Large catalogue integration tool 11.",
          declaration: expect.stringContaining(`readonly [${JSON.stringify(targetName)}]`),
        },
        called: {
          content: [{ type: "text", text: `called:${targetName}` }],
          details: { name: targetName },
        },
      },
    });
    expect(result.details).toMatchObject({
      presentation: {
        nested_tool_count: 1,
        nested_tools: [{ name: targetName, outcome: "success" }],
      },
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

    const created = await executeTool(fixture.session, "codemode_execute", {
      script:
        'const savedDynamic = tools.dynamic_later; const found = await tools.codemode_search({ query: "dynamic_later" }); return { hasTool: Object.keys(tools).includes("dynamic_later"), found: found.items[0] };',
      wait: true,
    });
    const createdDetails = codeModeResult(created);
    expect(createdDetails).toMatchObject({
      result: "success",
      data: {
        hasTool: true,
        found: {
          name: "dynamic_later",
          description: "First dynamic catalogue description.",
        },
      },
    });
    expect(JSON.stringify(createdDetails)).toContain(
      'Promise<PiToolResult<{ readonly [\\"dynamic\\"]: true; }>>',
    );

    fixture.registerDynamicTool("Replacement dynamic catalogue description.");
    const changedMidBatch = await executeTool(fixture.session, "codemode_execute", {
      script:
        'const beforeHide = await tools.codemode_search({ query: "dynamic_later" }); const outcomes = await Promise.all([tools.hide_dynamic({}), tools.dynamic_later({ text: "must not run" }).then(() => "ran", (error) => error.code)]); const afterHide = await tools.codemode_search({ query: "dynamic_later" }); return { outcome: outcomes[1], before: beforeHide.items[0]?.description, after: afterHide.items[0]?.description };',
      sessionId: createdDetails.sessionId,
      wait: true,
    });
    expect(codeModeResult(changedMidBatch)).toMatchObject({
      result: "success",
      data: {
        outcome: "unknown-tool",
        before: "Replacement dynamic catalogue description.",
        after: "Replacement dynamic catalogue description.",
      },
    });
    await fixture.session.extensionRunner.emitBeforeAgentStart("synchronize", undefined, "test", {
      cwd: ".",
    });

    expect(fixture.session.getActiveToolNames()).not.toContain("dynamic_later");
    expect(executeDescription(fixture.session)).not.toContain('readonly ["dynamic_later"]');
    expect(fixture.session.getActiveToolNames()).toEqual(
      expect.arrayContaining([
        "codemode_execute",
        "codemode_result",
        "codemode_cancel",
        "codemode_sessions",
        "codemode_search",
      ]),
    );

    const hidden = await executeTool(fixture.session, "codemode_execute", {
      script:
        'const found = await tools.codemode_search({ query: "dynamic_later" }); try { await savedDynamic({ text: "must not run" }); return "unexpected"; } catch (error) { return { code: error.code, name: error.name, searchIncludesDynamic: found.items.some((item) => item.name === "dynamic_later") }; }',
      sessionId: createdDetails.sessionId,
      wait: true,
    });
    expect(codeModeResult(hidden)).toMatchObject({
      result: "success",
      data: {
        code: "unknown-tool",
        name: "CodeModeToolError",
        searchIncludesDynamic: false,
      },
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

  test("lists live Sessions and reclaims the least-recently-used idle Session", async () => {
    const fixture = await createCodeModeExtensionFixture({ maxSessions: 2 });
    const first = codeModeResult(
      await executeTool(fixture.session, "codemode_execute", { script: "1", wait: true }),
    );
    const second = codeModeResult(
      await executeTool(fixture.session, "codemode_execute", { script: "2", wait: true }),
    );
    await executeTool(fixture.session, "codemode_result", { sessionId: first.sessionId });

    const listed = codeModeSessionsResult(
      await executeTool(fixture.session, "codemode_sessions", {}),
    );
    expect(listed.sessions).toMatchObject([
      { sessionId: second.sessionId, state: "idle", cellCount: 1 },
      { sessionId: first.sessionId, state: "idle", cellCount: 1 },
    ]);

    const replacement = codeModeResult(
      await executeTool(fixture.session, "codemode_execute", { script: "3", wait: true }),
    );
    expect(replacement).toMatchObject({
      result: "success",
      data: 3,
      reclaimedSessionId: second.sessionId,
    });
    expect(
      codeModeResult(
        await executeTool(fixture.session, "codemode_result", {
          sessionId: second.sessionId,
        }),
      ),
    ).toMatchObject({ result: "failed", error: { code: "eviction" } });
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
      "codemode_sessions",
      "codemode_search",
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
