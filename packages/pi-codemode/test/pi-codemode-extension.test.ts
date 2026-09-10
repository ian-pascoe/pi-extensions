import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message, StreamFunction, StreamOptions, Usage } from "@earendil-works/pi-ai";
import { splitDeferredTools } from "@earendil-works/pi-ai/utils/deferred-tools";
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
  ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
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
import {
  CODEMODE_NESTED_TOOLS_ENTRY_TYPE,
  CodeModeNestedToolsTranscriptSchema,
} from "../src/codemode-nested-tool-rendering.js";

const fixtureDirectories: string[] = [];
const fixtureSessions: AgentSession[] = [];
let fixtureToolCallSequence = 0;
const CODEMODE_RENDERED_TOOL_NAMES = [
  "codemode_execute",
  "codemode_result",
  "codemode_cancel",
  "codemode_sessions",
  "codemode_search",
] as const;
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
  codemodeSettings?: CodeModeSettingsTestInput | false,
  bind = true,
): Promise<CodeModeExtensionFixture> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-codemode-extension-cwd-"));
  const agentDirectory = await mkdtemp(join(tmpdir(), "pi-codemode-extension-agent-"));
  fixtureDirectories.push(cwd, agentDirectory);
  await mkdir(join(cwd, ".pi"));
  await writeFile(join(cwd, ".pi/settings.json"), "{}");
  await writeFile(
    join(agentDirectory, "settings.json"),
    JSON.stringify(codemodeSettings ? { codemode: codemodeSettings } : {}),
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
    extensionFactories:
      codemodeSettings === false ? [extensionFactory] : [extensionFactory, piCodeModeExtension],
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
    `test-${name}-${++fixtureToolCallSequence}`,
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

function nestedTranscripts(session: AgentSession) {
  return session.sessionManager.getBranch().flatMap((entry) => {
    if (entry.type !== "custom" || entry.customType !== CODEMODE_NESTED_TOOLS_ENTRY_TYPE) return [];
    if (!Value.Check(CodeModeNestedToolsTranscriptSchema, entry.data))
      throw new Error("Invalid nested Transcript");
    return [entry.data];
  });
}

function codeModeToolNames(session: AgentSession): string[] {
  return session
    .getAllTools()
    .map(({ name }) => name)
    .filter((name) => name.startsWith("codemode_"));
}

async function serializeAnthropicRequest(session: AgentSession, messages: Message[]) {
  const entry = import.meta.resolve("@earendil-works/pi-ai");
  const api: { stream: StreamFunction<"anthropic-messages", StreamOptions & { client: object }> } =
    await import(new URL("./api/anthropic-messages.js", entry).href);
  const prepared = await session.extensionRunner.emitBeforeAgentStart(
    "synchronize",
    undefined,
    session.systemPrompt,
    { cwd: session.sessionManager.getCwd() },
  );
  const sentinel = "STOP BEFORE ANTHROPIC TRANSPORT";
  let captured: unknown;
  let transports = 0;
  const response = await api
    .stream(
      getModel("anthropic", "claude-sonnet-4-5"),
      {
        systemPrompt: prepared?.systemPrompt ?? session.systemPrompt,
        tools: session.agent.state.tools,
        messages,
      },
      {
        client: {
          beta: {
            messages: {
              create() {
                transports += 1;
                throw new Error("Unexpected transport");
              },
            },
          },
        },
        sessionId: "plan-004-fixed-routing-key",
        cacheRetention: "short",
        onPayload(payload) {
          captured = structuredClone(payload);
          throw new Error(sentinel);
        },
      },
    )
    .result();
  expect(response.stopReason).toBe("error");
  expect(response.errorMessage).toContain(sentinel);
  expect(transports).toBe(0);
  const payloadSchema = Type.Object({
    tools: Type.Array(Type.Unknown(), { minItems: 1 }),
    system: Type.Array(Type.Unknown(), { minItems: 1 }),
    messages: Type.Array(
      Type.Object({
        role: Type.String(),
        content: Type.Array(Type.Record(Type.String(), Type.Unknown())),
      }),
      { minItems: 1 },
    ),
  });
  if (!Value.Check(payloadSchema, captured))
    throw new Error("Unexpected installed Anthropic payload");
  return captured;
}

function executeContract(session: AgentSession) {
  const definition = session.getToolDefinition("codemode_execute");
  if (definition === undefined) throw new Error("Missing CodeMode execute definition");
  const { name, description, parameters, promptSnippet, promptGuidelines } = definition;
  return structuredClone({ name, description, parameters, promptSnippet, promptGuidelines });
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
  test("keeps fast async completion attached while the outer result is awaiting persistence", async () => {
    initTheme("dark");
    const { session, extensionApi } = await createCodeModeExtensionFixture();
    const gate = Promise.withResolvers<void>();
    extensionApi.registerTool({
      name: "fast_async",
      label: "Fast",
      description: "Waits",
      parameters: Type.Object({}),
      async execute() {
        await gate.promise;
        return { content: [{ type: "text", text: "fast-async-result" }], details: {} };
      },
    });
    await executeTool(session, "codemode_execute", {
      wait: false,
      script: "await tools.fast_async({});",
    });
    // An outer tool_result hook can delay persistence after execute has returned pending.
    gate.resolve();
    await expect.poll(() => nestedTranscripts(session).length).toBe(1);
    const entry = session.sessionManager.getLeafEntry();
    if (entry?.type !== "custom") throw new Error("Missing async entry");
    const renderer = session.extensionRunner.getEntryRenderer(entry.customType);
    expect(
      renderer?.(entry, { expanded: false }, session.extensionRunner.getUIContext().theme),
    ).toBeUndefined();
    await session.extensionRunner.emit({ type: "agent_end", messages: [] });
    // With no retained owner after the turn, history still has a standalone fallback.
    expect(
      renderer?.(entry, { expanded: false }, session.extensionRunner.getUIContext().theme)
        ?.render(100)
        .join("\n"),
    ).toContain("fast-async-result");
  });

  test.each(["completed", "failed", "cancelled"])(
    "refreshes the original async Cell after %s without polling or a tail duplicate",
    async (terminal) => {
      initTheme("dark");
      const { session, extensionApi } = await createCodeModeExtensionFixture();
      const gate = Promise.withResolvers<void>();
      const started = Promise.withResolvers<void>();
      const output =
        terminal === "cancelled"
          ? "outcome unknown"
          : terminal === "failed"
            ? "ASYNC-FAILURE"
            : "ASYNC-OWNED-OUTPUT";
      extensionApi.registerTool({
        name: "async_owned",
        label: "Async Owned",
        description: "Waits",
        parameters: Type.Object({}),
        async execute() {
          started.resolve();
          await gate.promise;
          if (terminal === "failed") throw new Error("ASYNC-FAILURE");
          return { content: [{ type: "text", text: "ASYNC-OWNED-OUTPUT" }], details: {} };
        },
      });
      const args = {
        sessionId: "async-owner",
        wait: false,
        script: "await tools.async_owned({}); return 7;",
      };
      const pending = await activeTool(session, "codemode_execute").execute(
        "async-owner-call",
        args,
        new AbortController().signal,
      );
      expect(codeModeResult(pending).result).toBe("pending");
      session.sessionManager.appendMessage({
        role: "toolResult",
        toolCallId: "async-owner-call",
        toolName: "codemode_execute",
        content: pending.content,
        details: pending.details,
        isError: false,
        timestamp: Date.now(),
      });
      // SAFETY: Native rows need only redraw capability, not a terminal.
      const ui = { requestRender: () => {} } as TUI;
      const makeRow = () =>
        new ToolExecutionComponent(
          "codemode_execute",
          "async-owner-call",
          args,
          {},
          session.getToolDefinition("codemode_execute"),
          ui,
          session.sessionManager.getCwd(),
        );
      const row = makeRow();
      row.updateResult({ ...pending, isError: false });
      expect(row.render(100).join("\n")).not.toContain(output);
      await started.promise;
      if (terminal === "cancelled")
        await executeTool(session, "codemode_cancel", { sessionId: "async-owner" });
      gate.resolve();
      await expect.poll(() => row.render(100).join("\n")).toContain(output);
      expect(codeModeResult(pending).result).toBe("pending");
      const entry = session.sessionManager
        .getBranch()
        .find(
          (entry) =>
            entry.type === "custom" && entry.customType === CODEMODE_NESTED_TOOLS_ENTRY_TYPE,
        );
      if (entry?.type !== "custom") throw new Error("Missing durable async Transcript");
      expect(
        session.extensionRunner.getEntryRenderer(entry.customType)?.(
          entry,
          { expanded: false },
          session.extensionRunner.getUIContext().theme,
        ),
      ).toBeUndefined();
      const replay = makeRow();
      replay.updateResult({ ...pending, isError: false });
      expect(replay.render(100).join("\n")).toContain(output);
      await executeTool(session, "codemode_result", { sessionId: "async-owner" });
      expect(nestedTranscripts(session)).toHaveLength(1);
    },
  );

  test("places waited native rows before the next precreated outer tool row, including replay", async () => {
    initTheme("dark");
    const { session } = await createCodeModeExtensionFixture();
    const args = {
      sessionId: "reused-session",
      script: "await tools.closure_echo({value: 81}); return 'CELL-A-DONE';",
    };
    const liveTail: Array<boolean> = [];
    const unsubscribe = session.subscribe((event) => {
      if (
        event.type === "entry_appended" &&
        event.entry.type === "custom" &&
        event.entry.customType === CODEMODE_NESTED_TOOLS_ENTRY_TYPE
      ) {
        liveTail.push(
          session.extensionRunner.getEntryRenderer(event.entry.customType)?.(
            event.entry,
            { expanded: false },
            session.extensionRunner.getUIContext().theme,
          ) !== undefined,
        );
      }
    });
    // Pi precreates both outer rows from the assistant message, even for sequential tools.
    // SAFETY: ToolExecutionComponent uses only this redraw capability, not a terminal.
    const ui = { requestRender: () => {} } as TUI;
    const createRows = () => [
      new ToolExecutionComponent(
        "codemode_execute",
        "outer-A",
        args,
        {},
        session.getToolDefinition("codemode_execute"),
        ui,
        session.sessionManager.getCwd(),
      ),
      new ToolExecutionComponent(
        "outer-B",
        "outer-B",
        {},
        {},
        undefined,
        ui,
        session.sessionManager.getCwd(),
      ),
    ];
    const liveRows = createRows();
    const result = await activeTool(session, "codemode_execute").execute(
      "outer-A",
      args,
      new AbortController().signal,
    );
    unsubscribe();
    expect(liveTail).toEqual([false]);
    const savedEntry = session.sessionManager.getLeafEntry();
    session.sessionManager.appendMessage({
      role: "toolResult",
      toolCallId: "outer-A",
      toolName: "codemode_execute",
      content: result.content,
      details: result.details,
      isError: false,
      timestamp: Date.now(),
    });
    for (const rows of [liveRows, createRows()]) {
      rows[0]?.updateResult({ ...result, isError: false });
      rows[1]?.updateResult({ content: [{ type: "text", text: "OUTER-B" }], isError: false });
      const tail = session.sessionManager
        .getBranch()
        .flatMap((entry) =>
          entry.type === "custom" && entry.customType === CODEMODE_NESTED_TOOLS_ENTRY_TYPE
            ? [
                session.extensionRunner.getEntryRenderer(entry.customType)?.(
                  entry,
                  { expanded: false },
                  session.extensionRunner.getUIContext().theme,
                ),
              ]
            : [],
        );
      const text = [...rows, ...tail]
        .flatMap((component) => component?.render(100) ?? [])
        .join("\n");
      expect(text.indexOf("registered-closure:81")).toBeGreaterThan(text.indexOf("CELL-A-DONE"));
      expect(text.indexOf("registered-closure:81")).toBeLessThan(text.indexOf("OUTER-B"));
      expect(text.match(/registered-closure:81/g)).toHaveLength(1);
    }
    if (savedEntry?.type !== "custom") throw new Error("Missing replay entry");
    session.sessionManager.branch(savedEntry.id);
    // A crash/branch ending before the owner result must not hide its durable rows.
    expect(
      session.extensionRunner
        .getEntryRenderer(savedEntry.customType)?.(
          savedEntry,
          { expanded: false },
          session.extensionRunner.getUIContext().theme,
        )
        ?.render(100)
        .join("\n"),
    ).toContain("registered-closure:81");
    await session.extensionRunner.emit({ type: "session_start", reason: "reload" });
    const newer = await activeTool(session, "codemode_execute").execute(
      "outer-A",
      { ...args, script: "await tools.closure_echo({value: 82});" },
      new AbortController().signal,
    );
    const oldRow = createRows()[0];
    oldRow?.updateResult({ ...result, isError: false });
    expect(oldRow?.render(100).join("\n")).toContain("registered-closure:81");
    expect(oldRow?.render(100).join("\n")).not.toContain("registered-closure:82");
    oldRow?.updateResult({ ...newer, isError: false });
    expect(oldRow?.render(100).join("\n")).toContain("registered-closure:82");
  });

  test("retains a known blocked result even when its sibling never finishes", async () => {
    const { session, extensionApi } = await createCodeModeExtensionFixture();
    const started = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    extensionApi.on("tool_call", (event) =>
      event.toolName === "closure_echo"
        ? { block: true, reason: "blocked-before-execution" }
        : undefined,
    );
    extensionApi.registerTool({
      name: "hung_sibling",
      label: "Hung",
      description: "Waits",
      parameters: Type.Object({}),
      async execute() {
        started.resolve();
        await gate.promise;
        return { content: [], details: {} };
      },
    });
    await executeTool(session, "codemode_execute", {
      sessionId: "blocked",
      wait: false,
      script: "await Promise.allSettled([tools.closure_echo({value:1}), tools.hung_sibling({})]);",
    });
    await started.promise;
    await executeTool(session, "codemode_cancel", { sessionId: "blocked" });
    gate.resolve();
    expect(nestedTranscripts(session)[0]?.calls.map((call) => call.outcome)).toEqual([
      "failed",
      "unknown",
    ]);
  });

  test("keeps the known outcome when an unsafe native result cannot be spilled", async () => {
    const { session, extensionApi } = await createCodeModeExtensionFixture();
    let reads = 0;
    extensionApi.registerTool({
      name: "unsafe_native",
      label: "Unsafe",
      description: "Has an accessor",
      parameters: Type.Object({}),
      async execute() {
        return {
          content: [],
          get details() {
            reads += 1;
            throw new Error("unsafe-details");
          },
        };
      },
    });
    await executeTool(session, "codemode_execute", { script: "await tools.unsafe_native({});" });
    expect(nestedTranscripts(session)[0]?.calls[0]).toMatchObject({
      outcome: "success",
      resultPreview: expect.stringContaining("unsafe"),
    });
    // The existing guest bridge may read the accessor; human capture must not add another read.
    expect(reads).toBe(1);
  });

  test("captures final hooked results before guest translation", async () => {
    const { session, extensionApi } = await createCodeModeExtensionFixture();
    extensionApi.on("tool_result", (event) =>
      event.toolName === "closure_echo"
        ? {
            content: [{ type: "text", text: "hooked-result" }],
            details: { hooked: true },
            isError: true,
          }
        : undefined,
    );
    const result = await executeTool(session, "codemode_execute", {
      script: "await tools.closure_echo({value: 5});",
    });
    expect(codeModeResult(result).result).toBe("failed");
    expect(nestedTranscripts(session)[0]?.calls[0]).toMatchObject({
      outcome: "failed",
      result: {
        content: [{ type: "text", text: "hooked-result" }],
        details: { hooked: true },
        isError: true,
      },
    });
  });

  test("bounds saved oversized native results and keeps a live Result Spill without changing Cell data", async () => {
    const { session, extensionApi } = await createCodeModeExtensionFixture();
    const text = "oversized-output\n".repeat(5_000);
    extensionApi.registerTool({
      name: "large_native",
      label: "Large Native",
      description: "Returns large text",
      parameters: Type.Object({}),
      async execute() {
        return { content: [{ type: "text", text }], details: {} };
      },
    });
    const result = await executeTool(session, "codemode_execute", {
      script: "await tools.large_native({}); return 3;",
    });
    expect(codeModeResult(result)).toMatchObject({ result: "success", data: 3 });
    const call = nestedTranscripts(session)[0]?.calls[0];
    expect(call?.result).toBeUndefined();
    expect(call?.resultPreview).toBeDefined();
    expect(Buffer.byteLength(JSON.stringify(call))).toBeLessThan(52_000);
    if (call?.spillPath === undefined) throw new Error("Missing nested Result Spill");
    await expect
      .poll(async () => (await readFile(call.spillPath!, "utf8")).length)
      .toBeGreaterThan(text.length);
    expect(JSON.stringify(result.content)).not.toContain("oversized-output");
  });

  test.each(["tree", "reload"])(
    "does not attach old background results after %s changes ownership",
    async (change) => {
      const { session, extensionApi } = await createCodeModeExtensionFixture();
      const started = Promise.withResolvers<void>();
      const gate = Promise.withResolvers<void>();
      extensionApi.registerTool({
        name: "old_branch",
        label: "Old Branch",
        description: "Waits on old branch",
        parameters: Type.Object({}),
        async execute() {
          started.resolve();
          await gate.promise;
          return { content: [{ type: "text", text: "old-branch-result" }], details: {} };
        },
      });
      await executeTool(session, "codemode_execute", {
        sessionId: "ownership",
        wait: false,
        script: "await tools.old_branch({});",
      });
      await started.promise;
      if (change === "tree") {
        const leaf = session.sessionManager.getLeafId();
        await session.extensionRunner.emit({
          type: "session_tree",
          newLeafId: leaf,
          oldLeafId: leaf,
        });
      } else {
        await session.extensionRunner.emit({ type: "session_start", reason: "reload" });
      }
      gate.resolve();
      if (change === "tree") await pollCodeModeSession(session, "ownership");
      await executeTool(session, "codemode_execute", {
        script: "await tools.closure_echo({value: 2});",
      });
      expect(nestedTranscripts(session)).toHaveLength(1);
      expect(nestedTranscripts(session)[0]?.calls.map((call) => call.name)).toEqual([
        "closure_echo",
      ]);
    },
  );

  test("reopens durable native rows without executing the tool or exposing custom entries to the model", async () => {
    const { session } = await createCodeModeExtensionFixture();
    await executeTool(session, "codemode_execute", {
      sessionId: "replay",
      script: "await tools.closure_echo({value: 77}); return 1;",
    });
    const manager = session.sessionManager;
    const file = join(manager.getCwd(), "replay.jsonl");
    await writeFile(
      file,
      [manager.getHeader(), ...manager.getEntries()]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
    const reopened = SessionManager.open(file);
    const entry = reopened
      .getBranch()
      .find(
        (entry) => entry.type === "custom" && entry.customType === CODEMODE_NESTED_TOOLS_ENTRY_TYPE,
      );
    if (entry?.type !== "custom") throw new Error("Missing saved Transcript");
    expect(JSON.stringify(reopened.buildSessionContext().messages)).not.toContain(
      "registered-closure:77",
    );
    const renderer = session.extensionRunner.getEntryRenderer(CODEMODE_NESTED_TOOLS_ENTRY_TYPE);
    initTheme("dark");
    const component = renderer?.(
      entry,
      { expanded: true },
      session.extensionRunner.getUIContext().theme,
    );
    expect(component?.render(100).join("\n")).toContain("registered-closure:77");
    expect(nestedTranscripts(session)).toHaveLength(1);
  });

  test("keeps finished calls and marks unfinished outcomes unknown on cancellation, ignoring late results", async () => {
    const { session, extensionApi } = await createCodeModeExtensionFixture();
    const started = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    extensionApi.registerTool({
      name: "ignores_abort",
      label: "Ignores Abort",
      description: "Ignores cancellation",
      parameters: Type.Object({}),
      async execute() {
        started.resolve();
        await gate.promise;
        return { content: [{ type: "text", text: "late-side-effect" }], details: {} };
      },
    });
    await executeTool(session, "codemode_execute", {
      sessionId: "cancel-transcript",
      wait: false,
      script: "await tools.closure_echo({value: 1}); await tools.ignores_abort({});",
    });
    await started.promise;
    await executeTool(session, "codemode_cancel", { sessionId: "cancel-transcript" });
    expect(nestedTranscripts(session)[0]?.calls.map((call) => [call.name, call.outcome])).toEqual([
      ["closure_echo", "success"],
      ["ignores_abort", "unknown"],
    ]);
    const saved = JSON.stringify(nestedTranscripts(session));
    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(JSON.stringify(nestedTranscripts(session))).toBe(saved);
    expect(saved).not.toContain("late-side-effect");
  });

  test("retains native edit diff and failures independently of the Cell's returned data", async () => {
    const { session } = await createCodeModeExtensionFixture();
    const path = join(session.sessionManager.getCwd(), "nested-edit.txt");
    await writeFile(path, "before\n");
    const result = await executeTool(session, "codemode_execute", {
      sessionId: "edit-transcript",
      script: `await tools.edit({path: ${JSON.stringify(path)}, oldText: 'before', newText: 'after'}); await tools.read({path: 'does-not-exist'});`,
    });
    expect(codeModeResult(result).result).toBe("failed");
    expect(await readFile(path, "utf8")).toBe("after\n");
    const [transcript] = nestedTranscripts(session);
    expect(transcript?.calls.map((call) => [call.name, call.outcome])).toEqual([
      ["edit", "success"],
      ["read", "failed"],
    ]);
    expect(transcript?.calls[0]?.result?.details).toMatchObject({
      diff: expect.stringContaining("after"),
    });
    expect(transcript?.calls[1]?.result?.isError).toBe(true);
  });

  test("records every parallel call in invocation order when a background Cell finishes without polling", async () => {
    const { session, extensionApi } = await createCodeModeExtensionFixture();
    const gate = Promise.withResolvers<void>();
    extensionApi.registerTool({
      name: "gated",
      label: "Gated",
      description: "Waits for a test gate",
      parameters: ClosureEchoParametersSchema,
      async execute(_id, { value }) {
        if (value === 0) await gate.promise;
        return { content: [{ type: "text", text: `finished:${value}` }], details: { value } };
      },
    });
    const pending = await executeTool(session, "codemode_execute", {
      sessionId: "parallel-transcript",
      wait: false,
      script:
        "await Promise.all(Array.from({length: 25}, (_, value) => tools.gated({value}))); return 7;",
    });
    expect(codeModeResult(pending).result).toBe("pending");
    expect(nestedTranscripts(session)).toEqual([]);
    gate.resolve();
    await expect.poll(() => nestedTranscripts(session).length).toBe(1);
    const [transcript] = nestedTranscripts(session);
    expect(transcript?.calls.map((call) => call.args?.value)).toEqual(
      Array.from({ length: 25 }, (_, i) => i),
    );
    expect(transcript?.calls.every((call) => call.outcome === "success")).toBe(true);
    expect(new Set(transcript?.calls.map((call) => call.callId)).size).toBe(25);
    await pollCodeModeSession(session, "parallel-transcript");
    await executeTool(session, "codemode_execute", {
      sessionId: "parallel-transcript",
      script: "await tools.closure_echo({value: 9});",
    });
    expect(nestedTranscripts(session).map((entry) => entry.cellOrdinal)).toEqual([1, 2]);
  });

  test("retains nested native tool displays once without adding them to model context", async () => {
    const { session } = await createCodeModeExtensionFixture();
    const result = await executeTool(session, "codemode_execute", {
      sessionId: "transcript",
      script: "await tools.closure_echo({ value: 42 }); return 'only-cell-result';",
    });
    expect(codeModeResult(result)).toEqual({
      result: "success",
      sessionId: "transcript",
      data: "only-cell-result",
    });
    const entries = session.sessionManager
      .getBranch()
      .filter(
        (entry) => entry.type === "custom" && entry.customType === "pi-codemode:nested-tools",
      );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      data: {
        version: 1,
        sessionId: "transcript",
        cellOrdinal: 1,
        calls: [
          {
            name: "closure_echo",
            args: { value: 42 },
            outcome: "success",
            result: {
              content: [{ type: "text", text: "registered-closure:42" }],
              details: { closure: "registered-closure", value: 42 },
              isError: false,
            },
          },
        ],
      },
    });
    expect(JSON.stringify(session.sessionManager.buildSessionContext().messages)).not.toContain(
      "registered-closure:42",
    );
    await executeTool(session, "codemode_result", { sessionId: "transcript" });
    await executeTool(session, "codemode_result", { sessionId: "transcript" });
    expect(
      session.sessionManager
        .getBranch()
        .filter(
          (entry) => entry.type === "custom" && entry.customType === "pi-codemode:nested-tools",
        ),
    ).toHaveLength(1);
  });

  test("registers tools inertly, then composes Pi tools through a reusable CodeMode Session", async () => {
    const fixture = await createCodeModeExtensionFixture(
      {
        tools: [{ pattern: "closure_echo", exposure: "codemode-only" }],
      },
      false,
    );
    const unboundContract = executeContract(fixture.session);

    expect(codeModeToolNames(fixture.session)).toEqual([
      "codemode_execute",
      "codemode_result",
      "codemode_cancel",
      "codemode_sessions",
      "codemode_search",
    ]);
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
    expect(executeContract(fixture.session)).toEqual(unboundContract);
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
    expect(executeDescription(fixture.session)).not.toMatch(
      /Current CodeMode tool declarations|COMPLETE|PARTIAL|readonly \[/,
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
    const discovered = codeModeToolSearchPage(
      await executeTool(fixture.session, "codemode_search", { query: "closure" }),
    );
    expect(discovered).toMatchObject({
      total: 1,
      items: [
        {
          name: "closure_echo",
          description: "Returns a distinctive registered extension closure.",
        },
      ],
    });
    expect(discovered.items[0]).not.toHaveProperty("declaration");
    expect(
      codeModeSessionsResult(await executeTool(fixture.session, "codemode_sessions", {})).sessions,
    ).toEqual([]);
    expect(executeDescription(fixture.session)).toBe(
      "Execute a TypeScript Cell in a persistent isolated Deno CodeMode Session. Reuse a Session ID to retain Notebook Bindings; an unknown supplied ID creates that Session. A new Session reclaims the least-recently-used idle Session at capacity. Use the read-only tools object for registered Pi tools. Return final result data with a top-level return statement. Reserve console.log, console.info, console.warn, console.error, and console.debug for diagnostics; captured output arrives only with terminal results. Discover tools with direct codemode_search before a Cell or tools.codemode_search inside one. Search an intent for exact flat names, then search an exact name for its complete declaration. Call tools[name](input).",
    );

    const started = await executeTool(fixture.session, "codemode_execute", {
      script:
        'type Count = number; let value: Count = 2; const [closure, read, write] = await Promise.all([tools.codemode_search({ query: "closure_echo" }), tools.codemode_search({ query: "read" }), tools.codemode_search({ query: "write" })]); console.log("value:", value); return { value, hasSearch: Object.keys(tools).includes("codemode_search"), closure: closure.items[0], readDeclaration: read.items[0]?.declaration, writeDeclaration: write.items[0]?.declaration };',
      sessionId: "named-session",
      wait: false,
    });
    const pending = codeModeResult(started);
    expect(pending).toEqual({ result: "pending", sessionId: "named-session" });
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
    expect(Object.hasOwn(first, "usage")).toBe(false);
    expect(Object.hasOwn(first, "addedToolNames")).toBe(false);
    expect(Object.hasOwn(first, "terminate")).toBe(false);

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
    expect(Object.hasOwn(reused, "terminate")).toBe(false);
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

  test("discovers and calls a tool from a large catalogue without inline declarations", async () => {
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
    await fixture.session.extensionRunner.emitBeforeAgentStart("synchronize", undefined, "test", {
      cwd: ".",
    });
    const description = executeDescription(fixture.session);
    expect(description).not.toMatch(/Current CodeMode tool declarations|COMPLETE|PARTIAL/);
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
    await expect.poll(() => readFile(spillPath, "utf8")).toBe(JSON.stringify(data, undefined, 2));
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
    let renderRequests = 0;
    let transientCaptureCleared = false;
    const setWidget = (
      key: string,
      content: ObserverWidgetFactory | undefined,
      options?: { readonly placement?: string },
    ): void => {
      if (key === "pi-codemode-transcript-render") {
        if (content !== undefined) {
          // SAFETY: This capability-only factory uses requestRender and no terminal operations.
          content(
            {
              requestRender: () => {
                renderRequests += 1;
              },
            } as TUI,
            fixture.session.extensionRunner.getUIContext().theme,
          );
        } else if (content === undefined) transientCaptureCleared = true;
        return;
      }
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
        setWidget: recordWidget,
      },
    });
    expect(widgetEvents).toEqual([]);
    expect(transientCaptureCleared).toBe(true);
    await executeTool(fixture.session, "codemode_execute", {
      script: "await tools.closure_echo({value: 4});",
    });
    const entry = fixture.session.sessionManager
      .getBranch()
      .find(
        (entry) => entry.type === "custom" && entry.customType === CODEMODE_NESTED_TOOLS_ENTRY_TYPE,
      );
    if (entry?.type !== "custom") throw new Error("Missing nested entry");
    fixture.session.extensionRunner
      .getEntryRenderer(CODEMODE_NESTED_TOOLS_ENTRY_TYPE)?.(
        entry,
        { expanded: true },
        fixture.session.extensionRunner.getUIContext().theme,
      )
      ?.render(80);
    expect(renderRequests).toBeGreaterThan(0);

    const started = await executeTool(fixture.session, "codemode_execute", {
      script: "while (true) {}",
      wait: false,
    });
    const pending = codeModeResult(started);
    expect(widgetEvents).toContainEqual({
      content: expect.any(Function),
      placement: "aboveEditor",
    });

    await executeTool(fixture.session, "codemode_cancel", { sessionId: pending.sessionId });
  }, 30_000);

  test("does not reactivate a tool disabled before exposure policy installs", async () => {
    const fixture = await createCodeModeExtensionFixture(
      {
        tools: [
          { pattern: "*", exposure: "codemode-only" },
          { pattern: "bash", exposure: "direct-and-codemode" },
        ],
      },
      false,
    );
    fixture.extensionApi.setActiveTools(
      fixture.extensionApi.getActiveTools().filter((name) => name !== "bash"),
    );

    await fixture.session.bindExtensions({
      mode: "rpc",
      uiContext: fixture.session.extensionRunner.getUIContext(),
    });

    expect(fixture.session.getActiveToolNames()).not.toContain("bash");
    expect(executeDescription(fixture.session)).not.toContain('readonly ["bash"]');
    const result = await executeTool(fixture.session, "codemode_execute", {
      script: 'return { hasBash: Object.hasOwn(tools, "bash") };',
      wait: true,
    });
    expect(codeModeResult(result)).toMatchObject({
      result: "success",
      data: { hasBash: false },
    });
  });

  test.each([false, true])(
    "preserves immediate tool definitions across MCP refresh with late foreign tools (CodeMode=%s)",
    async (codeMode) => {
      const fixture = await createCodeModeExtensionFixture(
        codeMode
          ? { tools: [{ pattern: "mcp__example__hidden", exposure: "codemode-only" }] }
          : false,
      );
      const { session, extensionApi } = fixture;
      const unexpectedNetworkCall = async (): Promise<never> => {
        throw new Error("Catalogue reconciliation must not call the MCP Server");
      };
      const runtime = {
        callServerTool: unexpectedNetworkCall,
        listResources: unexpectedNetworkCall,
        listResourceTemplates: unexpectedNetworkCall,
        readResource: unexpectedNetworkCall,
      };
      const definitions = ["echo", "hidden"].map((name) => ({
        name,
        description: `Example ${name}`,
        inputSchema: { type: "object", properties: { text: { type: "string" } } },
      }));
      // Load the real sibling package without widening this package's TypeScript rootDir.
      const modulePath = new URL("../../pi-mcp/src/mcp-tool-catalog.js", import.meta.url).href;
      const {
        McpToolCatalog,
      }: {
        McpToolCatalog: new (
          pi: ExtensionAPI,
          host: typeof runtime,
        ) => {
          replaceServerTools(serverId: string, tools: typeof definitions): Promise<void>;
        };
      } = await import(modulePath);
      const catalogue = new McpToolCatalog(extensionApi, runtime);
      await catalogue.replaceServerTools("example", definitions);
      fixture.registerDynamicTool();
      extensionApi.registerTool({
        name: "load_mcp",
        label: "Load MCP",
        description: "Activate another Server Tool.",
        parameters: Type.Object({}),
        async execute() {
          await catalogue.replaceServerTools("example", [
            ...definitions,
            {
              name: "a_earlier",
              description: "New tool",
              inputSchema: { type: "object", properties: { text: { type: "string" } } },
            },
          ]);
          return { content: [{ type: "text", text: "Loaded" }], details: {} };
        },
      });
      const snapshot = async () => {
        const prepared = await session.extensionRunner.emitBeforeAgentStart(
          "synchronize",
          undefined,
          session.systemPrompt,
          { cwd: session.sessionManager.getCwd() },
        );
        return {
          systemPrompt: prepared?.systemPrompt ?? session.systemPrompt,
          tools: session.agent.state.tools.map(({ name, description, parameters }) => ({
            name,
            description,
            parameters,
          })),
        };
      };
      const before = await snapshot();
      const names = before.tools.map(({ name }) => name);
      expect(names).toContain("mcp__example__echo");
      expect(names.indexOf("dynamic_later")).toBeGreaterThan(names.indexOf("mcp__example__echo"));
      expect(names.includes("mcp__example__hidden")).toBe(!codeMode);
      for (let refresh = 0; refresh < 2; refresh += 1) {
        await catalogue.replaceServerTools("example", structuredClone(definitions));
        expect(await snapshot()).toEqual(before);
      }

      const result = await executeTool(session, "load_mcp", {});
      expect(result.addedToolNames).toContain("mcp__example__a_earlier");
      const messages: Message[] = [
        {
          role: "toolResult",
          toolCallId: "load",
          toolName: "load_mcp",
          content: result.content,
          addedToolNames: result.addedToolNames ?? [],
          isError: false,
          timestamp: 0,
        },
      ];
      const after = await snapshot();
      const placement = splitDeferredTools({ tools: after.tools, messages }, true);
      expect(placement.immediate.map(({ name }) => name)).toEqual(names);
      expect([...placement.deferred.keys()]).toEqual(["mcp__example__a_earlier"]);
      const fallback = splitDeferredTools({ tools: after.tools, messages }, false);
      const fallbackNames = fallback.immediate.map(({ name }) => name);
      expect(fallbackNames).toContain("mcp__example__a_earlier");
      expect(fallbackNames.filter((name) => name !== "mcp__example__a_earlier")).toEqual(names);
      expect(fixture.notifications).toEqual([]);
    },
  );

  test("preserves serialized Anthropic tools and system across live CodeMode-only discovery", async () => {
    const fixture = await createCodeModeExtensionFixture({
      tools: [{ pattern: "*", exposure: "codemode-only" }],
    });
    const { session } = fixture;
    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: "Use the live Tool Catalogue." }],
        timestamp: 0,
      },
    ];
    const before = await serializeAnthropicRequest(session, messages);
    expect(await serializeAnthropicRequest(session, messages)).toEqual(before);

    fixture.registerDynamicTool();
    const found = await executeTool(session, "codemode_search", { query: "dynamic_later" });
    expect(codeModeToolSearchPage(found)).toMatchObject({
      items: [
        {
          name: "dynamic_later",
          declaration: expect.stringContaining('readonly ["dynamic_later"]'),
        },
      ],
    });
    messages.push(
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "discover",
            name: "codemode_search",
            arguments: { query: "dynamic_later" },
          },
        ],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        usage: nestedUsage(0),
        stopReason: "toolUse",
        timestamp: 0,
      },
      {
        role: "toolResult",
        toolCallId: "discover",
        toolName: "codemode_search",
        content: found.content,
        isError: false,
        timestamp: 0,
      },
    );
    const after = await serializeAnthropicRequest(session, messages);
    expect(JSON.stringify(after.tools)).toBe(JSON.stringify(before.tools));
    expect(JSON.stringify(after.system)).toBe(JSON.stringify(before.system));
    expect(after.messages).toHaveLength(before.messages.length + 2);
    // Pi moves the history cache marker; prior message content must remain unchanged.
    const content = (items: typeof before.messages) =>
      items.map(({ role, content: blocks }) => ({
        role,
        content: blocks.map(({ cache_control: _cache, ...block }) => block),
      }));
    expect(content(after.messages.slice(0, before.messages.length))).toEqual(
      content(before.messages),
    );
    expect(after.messages.at(-1)).toMatchObject({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "discover", content: JSON.stringify(found.details) },
      ],
    });
    expect(await serializeAnthropicRequest(session, messages)).toEqual(after);
    expect(fixture.notifications).toEqual([]);
  });

  test("keeps the execute contract stable across CodeMode-only catalogue transitions", async () => {
    const fixture = await createCodeModeExtensionFixture({
      tools: [{ pattern: "*", exposure: "codemode-only" }],
    });
    const { session, extensionApi } = fixture;
    const requestedNames = session.getAllTools().map(({ name }) => name);
    const directNames = session.getActiveToolNames();
    const before = executeContract(session);
    const synchronize = () =>
      session.extensionRunner.emitBeforeAgentStart("synchronize", undefined, session.systemPrompt, {
        cwd: session.sessionManager.getCwd(),
      });

    fixture.registerDynamicTool();
    expect(session.getActiveToolNames()).toEqual(directNames);
    expect(executeContract(session)).toEqual(before);
    await synchronize();
    expect(executeContract(session)).toEqual(before);
    const discovered = codeModeToolSearchPage(
      await executeTool(session, "codemode_search", { query: "dynamic_later" }),
    );
    expect(discovered).toMatchObject({
      total: 1,
      items: [
        {
          name: "dynamic_later",
          declaration: expect.stringContaining('readonly ["text"]: string'),
        },
      ],
    });
    expect(executeContract(session)).toEqual(before);

    const started = codeModeResult(
      await executeTool(session, "codemode_execute", {
        script:
          'const savedDynamic = tools.dynamic_later; const page = await tools.codemode_search({ query: "dynamic_later" }); return { found: page.items[0], called: await tools[page.items[0].name]({ text: "discovered" }) };',
      }),
    );
    expect(started).toMatchObject({
      result: "success",
      data: {
        found: discovered.items[0],
        called: { content: [{ type: "text", text: "discovered" }] },
      },
    });
    expect(executeContract(session)).toEqual(before);

    extensionApi.registerTool({
      name: "dynamic_later",
      label: "Dynamic Later",
      description: "Replacement number input.",
      parameters: Type.Object({ count: Type.Number() }, { additionalProperties: false }),
      async execute(_id, input) {
        return {
          content: [{ type: "text", text: String(input.count) }],
          details: { count: input.count },
        };
      },
    });
    const replaced = codeModeToolSearchPage(
      await executeTool(session, "codemode_search", { query: "dynamic_later" }),
    );
    expect(replaced).toMatchObject({
      total: 1,
      items: [
        {
          name: "dynamic_later",
          description: "Replacement number input.",
          declaration: expect.stringContaining('readonly ["count"]: number'),
        },
      ],
    });
    expect(executeContract(session)).toEqual(before);
    expect(
      codeModeResult(
        await executeTool(session, "codemode_execute", {
          sessionId: started.sessionId,
          script: "return await savedDynamic({ count: 3 });",
        }),
      ),
    ).toMatchObject({ result: "success", data: { details: { count: 3 } } });
    expect(executeContract(session)).toEqual(before);

    // Restore the full requested set, including retained CodeMode-only tools.
    extensionApi.setActiveTools(requestedNames);
    expect(session.getActiveToolNames()).toEqual(directNames);
    expect(executeContract(session)).toEqual(before);
    expect(
      codeModeToolSearchPage(
        await executeTool(session, "codemode_search", {
          query: "dynamic_later",
        }),
      ).items.map(({ name }) => name),
    ).not.toContain("dynamic_later");
    expect(executeContract(session)).toEqual(before);
    expect(
      codeModeResult(
        await executeTool(session, "codemode_execute", {
          sessionId: started.sessionId,
          script:
            'const page = await tools.codemode_search({ query: "dynamic_later" }); try { await savedDynamic({ count: 3 }); return "unexpected"; } catch (error) { return { code: error.code, searchIncludesDynamic: page.items.some((item) => item.name === "dynamic_later"), hasTool: Object.hasOwn(tools, "dynamic_later") }; }',
        }),
      ),
    ).toMatchObject({
      result: "success",
      data: { code: "unknown-tool", searchIncludesDynamic: false, hasTool: false },
    });
    expect(executeContract(session)).toEqual(before);
    for (let refresh = 0; refresh < 2; refresh += 1) {
      await synchronize();
      expect(executeContract(session)).toEqual(before);
      expect(session.getActiveToolNames()).toEqual(directNames);
    }
    expect(before.description).not.toMatch(
      /Current CodeMode tool declarations|COMPLETE|PARTIAL|readonly \[/,
    );
    expect(fixture.notifications).toEqual([]);
  });

  test("discovers dynamic tools at a model-turn boundary without rewriting execute", async () => {
    const fixture = await createCodeModeExtensionFixture();
    const before = executeContract(fixture.session);
    fixture.registerDynamicTool();

    expect(fixture.session.getActiveToolNames()).toContain("dynamic_later");
    expect(executeContract(fixture.session)).toEqual(before);
    await fixture.session.extensionRunner.emitBeforeAgentStart("synchronize", undefined, "test", {
      cwd: ".",
    });
    expect(executeContract(fixture.session)).toEqual(before);
    expect(
      codeModeToolSearchPage(
        await executeTool(fixture.session, "codemode_search", {
          query: "dynamic_later",
        }),
      ),
    ).toMatchObject({
      total: 1,
      items: [
        {
          name: "dynamic_later",
          declaration: expect.stringContaining('readonly ["dynamic_later"]'),
        },
      ],
    });
  });

  test("keeps direct exposure, guest exposure, and the dynamic catalogue coherent", async () => {
    const fixture = await createCodeModeExtensionFixture({
      tools: [{ pattern: "*", exposure: "direct-and-codemode" }],
    });
    expect(executeDescription(fixture.session)).not.toContain('readonly ["dynamic_later"]');
    const beforeRegistration = codeModeResult(
      await executeTool(fixture.session, "codemode_execute", {
        script: 'return Object.hasOwn(tools, "dynamic_later");',
        wait: true,
      }),
    );
    expect(beforeRegistration).toMatchObject({ result: "success", data: false });

    fixture.registerDynamicTool("First dynamic catalogue description.");
    expect(fixture.session.getActiveToolNames()).toContain("dynamic_later");

    const created = await executeTool(fixture.session, "codemode_execute", {
      script:
        'const savedDynamic = tools.dynamic_later; const found = await tools.codemode_search({ query: "dynamic_later" }); return { hasTool: Object.keys(tools).includes("dynamic_later"), found: found.items[0] };',
      sessionId: beforeRegistration.sessionId,
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
    expect(activeTool(fixture.session, "dynamic_later").description).toBe(
      "Replacement dynamic catalogue description.",
    );
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

  test("leaves inert tools registered without changing active names for invalid settings", async () => {
    const fixture = await createCodeModeExtensionFixture({ maxSessions: 0 }, false);
    const activeNames = fixture.session.getActiveToolNames();

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

    expect(codeModeToolNames(fixture.session)).toEqual([
      "codemode_execute",
      "codemode_result",
      "codemode_cancel",
      "codemode_sessions",
      "codemode_search",
    ]);
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

  test("tears down the prior generation and restores rendered tools before reload startup", async () => {
    const fixture = await createCodeModeExtensionFixture();
    const hanging = codeModeResult(
      await executeTool(fixture.session, "codemode_execute", {
        script: "await new Promise(() => {});",
        wait: false,
      }),
    );
    expect(Object.hasOwn(fixture.session, "setActiveToolsByName")).toBe(true);

    let restoredBeforeRestart = false;
    let renderersAvailableBeforeRestart = false;
    await fixture.session.reload({
      beforeSessionStart: () => {
        restoredBeforeRestart = !Object.hasOwn(fixture.session, "setActiveToolsByName");
        renderersAvailableBeforeRestart = CODEMODE_RENDERED_TOOL_NAMES.every((toolName) => {
          const definition = fixture.session.getToolDefinition(toolName);
          return definition?.renderCall !== undefined && definition.renderResult !== undefined;
        });
      },
    });
    expect(restoredBeforeRestart).toBe(true);
    expect(renderersAvailableBeforeRestart).toBe(true);
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
