import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxToolCall,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import {
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, test } from "vitest";
import {
  expectToolOutputMatches,
  recordToolOutputs,
  toolOutputViolations,
  type ToolOutputDeclaration,
} from "../src/tool-testing.js";

const Output = Type.Object({ count: Type.Integer(), label: Type.String() });
const typed = { name: "typed", outputSchema: Output };
const untyped = { name: "untyped" };

describe("toolOutputViolations", () => {
  test("is empty for a conforming result", () => {
    expect(toolOutputViolations(typed, { structuredContent: { count: 1, label: "a" } })).toEqual(
      [],
    );
  });

  test("is empty for a tool without outputSchema whose result sets no structuredContent", () => {
    expect(toolOutputViolations(untyped, {})).toEqual([]);
    expect(toolOutputViolations(untyped, { isError: true })).toEqual([]);
  });

  test("flags structuredContent from a tool that declares no outputSchema", () => {
    const [violation, ...rest] = toolOutputViolations(untyped, { structuredContent: { count: 1 } });
    expect(violation).toMatch(/no outputSchema.*codemode scripts would get the text/);
    expect(rest).toEqual([]);
    expect(toolOutputViolations(untyped, { structuredContent: {}, isError: true })).toHaveLength(1);
  });

  test("flags a successful result without structuredContent from a tool with outputSchema", () => {
    expect(toolOutputViolations(typed, {})).toEqual([
      expect.stringMatching(/no structuredContent/),
    ]);
    expect(toolOutputViolations(typed, { isError: false })).toHaveLength(1);
  });

  test("lets an error result without structuredContent through", () => {
    expect(toolOutputViolations(typed, { isError: true })).toEqual([]);
  });

  test("checks an error result that carries structuredContent", () => {
    expect(
      toolOutputViolations(typed, { structuredContent: { count: 1, label: "a" }, isError: true }),
    ).toEqual([]);
    expect(
      toolOutputViolations(typed, { structuredContent: { count: "x" }, isError: true }),
    ).not.toEqual([]);
  });

  test("lists every schema violation by instance path", () => {
    const violations = toolOutputViolations(typed, { structuredContent: { count: "x" } });
    // The missing `label` is reported at the root, the wrong `count` at its path.
    expect(violations).toHaveLength(2);
    expect(violations.some((line) => /^structuredContent \/ .*label/.test(line))).toBe(true);
    expect(violations.some((line) => line.startsWith("structuredContent /count "))).toBe(true);
  });

  test("reports a non-object structuredContent at the root", () => {
    expect(toolOutputViolations(typed, { structuredContent: "text" })).toEqual([
      expect.stringMatching(/^structuredContent \/ /),
    ]);
  });
});

describe("expectToolOutputMatches", () => {
  test("passes a conforming result", () => {
    expect(() =>
      expectToolOutputMatches(typed, { structuredContent: { count: 1, label: "a" } }),
    ).not.toThrow();
  });

  test("throws naming the tool and listing every violation", () => {
    let message = "";
    try {
      expectToolOutputMatches(typed, { structuredContent: { count: "x" } });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    const [head, ...lines] = message.split("\n");
    expect(head).toBe("typed:");
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => line.startsWith("  structuredContent /"))).toBe(true);
  });

  test("names the tool for each rule", () => {
    expect(() => expectToolOutputMatches(untyped, { structuredContent: 1 })).toThrow(
      /^untyped:\n {2}result sets structuredContent but .*no outputSchema/,
    );
    expect(() => expectToolOutputMatches(typed, {})).toThrow(/^typed:\n {2}tool declares/);
  });
});

const directories: string[] = [];
const sessions: AgentSession[] = [];

afterEach(async () => {
  for (const session of sessions.splice(0)) session.dispose();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const retired = new Set<string>();
const text = (value: string) => [{ type: "text" as const, text: value }];

const tools = [
  defineTool({
    name: "good",
    label: "Good",
    description: "Conforming.",
    parameters: Type.Object({}),
    outputSchema: Output,
    async execute() {
      return {
        content: text("ok"),
        details: undefined,
        structuredContent: { count: 1, label: "good" },
      };
    },
  }),
  defineTool({
    name: "undeclared",
    label: "Undeclared",
    description: "Sets structuredContent without an outputSchema.",
    parameters: Type.Object({}),
    async execute() {
      return { content: text("ok"), details: undefined, structuredContent: { count: 1 } };
    },
  }),
  defineTool({
    name: "forgetful",
    label: "Forgetful",
    description: "Declares an outputSchema but sets no structuredContent.",
    parameters: Type.Object({}),
    outputSchema: Output,
    async execute() {
      return { content: text("ok"), details: undefined };
    },
  }),
  defineTool({
    name: "wrong",
    label: "Wrong",
    description: "Violates its outputSchema.",
    parameters: Type.Object({}),
    outputSchema: Output,
    async execute() {
      return { content: text("ok"), details: undefined, structuredContent: { count: "x" } };
    },
  }),
  defineTool({
    name: "retire",
    label: "Retire",
    description: "Removes `good` from the tool set the recorder looks up.",
    parameters: Type.Object({}),
    async execute() {
      retired.add("good");
      return { content: text("ok"), details: undefined };
    },
  }),
  defineTool({
    name: "failing",
    label: "Failing",
    description: "Throws, so its error result has no structuredContent.",
    parameters: Type.Object({}),
    outputSchema: Output,
    async execute() {
      throw new Error("boom");
    },
  }),
];

/** Replaces `count`, as a redaction extension replaces what scripts receive. */
const breakingRedactor: ExtensionFactory = (pi) => {
  pi.on("tool_result", (event) =>
    event.toolName === "good" ? { structuredContent: { count: "redacted", label: "good" } } : {},
  );
};

/** A real session that plays `turns` as the model's responses, then finishes. */
async function session(before: ExtensionFactory[], turns: readonly AssistantMessage[]) {
  retired.clear();
  let running: AgentSession | undefined;
  /** What a harness passes: the session's tool definitions, minus any a test retired. */
  const lookup = (name: string): ToolOutputDeclaration | undefined =>
    retired.has(name) ? undefined : running?.getToolDefinition(name);
  const recorder = recordToolOutputs(lookup);
  const cwd = await mkdtemp(join(tmpdir(), "pi-utils-tool-output-"));
  directories.push(cwd);
  const agentDir = join(cwd, "agent");
  await mkdir(agentDir);
  const model = getModel("deepseek", "deepseek-flash");
  if (model === undefined) throw new Error("Missing pinned DeepSeek model");
  const settings = SettingsManager.inMemory({
    retry: { enabled: false },
    codemode: { mode: "on" },
    defaultTools: ["codemode", ...tools.map(({ name }) => name)],
  });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: settings,
    noExtensions: false,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      { name: "codemode", factory: createCodemodeExtension(), builtin: true, replaceable: true },
      (pi) => {
        for (const tool of tools) pi.registerTool(tool);
      },
      (pi) =>
        pi.registerProvider("deepseek", {
          api: "openai-completions",
          models: [model],
          streamSimple() {
            throw new Error("Unexpected direct provider request");
          },
        }),
      ...before,
      recorder.extension,
    ],
    systemPromptOverride: () => "Standing instructions.",
  });
  await loader.reload();
  expect(loader.getExtensions().errors).toEqual([]);
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: join(cwd, "models.json"),
    allowModelNetwork: false,
  });
  await modelRuntime.setRuntimeApiKey("deepseek", "TEST-NOT-A-REAL-KEY");
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model,
    modelRuntime,
    resourceLoader: loader,
    sessionManager: SessionManager.create(cwd, cwd),
    settingsManager: settings,
  });
  sessions.push(session);
  running = session;
  const responses = [...turns, fauxAssistantMessage("Done.")];
  session.agent.streamFunction = (currentModel) => {
    const next = responses.shift();
    if (next === undefined) throw new Error("Unexpected model request");
    const message: AssistantMessage = {
      ...next,
      api: currentModel.api,
      provider: currentModel.provider,
      model: currentModel.id,
    };
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() =>
      stream.push({
        type: "done",
        reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
        message,
      }),
    );
    return stream;
  };
  await session.bindExtensions({ mode: "rpc" });
  await session.prompt("Go");
  return { session, recorder, lookup };
}

const script = (...names: string[]) =>
  fauxAssistantMessage(
    fauxToolCall("codemode", {
      code: names.map((name) => `try { await tools.${name}({}); } catch {}`).join("\n"),
    }),
    { stopReason: "toolUse" },
  );

describe("recordToolOutputs", () => {
  test("passes a session whose results all conform, nested codemode calls included", async () => {
    const { recorder } = await session([], [script("good", "failing")]);
    expect(recorder.outputs.map(({ toolName }) => toolName).toSorted()).toEqual([
      "codemode",
      "failing",
      "good",
    ]);
    const nested = recorder.outputs.find(({ toolName }) => toolName === "good");
    expect(nested?.toolCallId).toContain("/");
    expect(nested?.structuredContent).toEqual({ count: 1, label: "good" });
    expect(nested?.declaration?.outputSchema).toBe(Output);
    expect(() => recorder.check()).not.toThrow();
  });

  test("reports every violation together, naming each tool and call", async () => {
    const { recorder } = await session([], [script("good", "undeclared", "forgetful", "wrong")]);
    let message = "";
    try {
      recorder.check();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/^4 tool output violation\(s\):/);
    expect(message).toMatch(/undeclared \(call [^)]*\): .*no outputSchema/);
    expect(message).toMatch(/forgetful \(call [^)]*\): .*no structuredContent/);
    expect(message.match(/wrong \(call [^)]*\): structuredContent \//g)).toHaveLength(2);
    expect(message).not.toMatch(/good \(/);
  });

  test("records and checks calls the model issues directly", async () => {
    const { recorder } = await session(
      [],
      [fauxAssistantMessage(fauxToolCall("undeclared", {}), { stopReason: "toolUse" })],
    );
    expect(
      recorder.outputs.map(({ toolCallId, toolName }) => [toolName, toolCallId.includes("/")]),
    ).toEqual([["undeclared", false]]);
    expect(() => recorder.check()).toThrow(/undeclared \(call [^)]*\): .*no outputSchema/);
  });

  test("loaded last, it sees what an earlier handler left in the result", async () => {
    const { recorder } = await session([breakingRedactor], [script("good")]);
    expect(recorder.outputs.find(({ toolName }) => toolName === "good")?.structuredContent).toEqual(
      { count: "redacted", label: "good" },
    );
    expect(() => recorder.check()).toThrow(/good \(call [^)]*\): structuredContent \/count /);
  });

  test("judges each result by the tool as it was when the result fired", async () => {
    const { recorder, lookup } = await session([], [script("good", "retire")]);
    const good = recorder.outputs.find(({ toolName }) => toolName === "good");
    expect(good?.declaration?.outputSchema).toBe(Output);
    // A lookup at the end would no longer find the tool, and would flag its structuredContent.
    expect(lookup("good")).toBeUndefined();
    expect(() => recorder.check()).not.toThrow();
  });

  test("records an absent tool as undeclared", async () => {
    const { recorder } = await session([], [script("retire", "good")]);
    // `retire` ran first, so `good` was already gone when its result fired.
    expect(
      recorder.outputs.find(({ toolName }) => toolName === "good")?.declaration,
    ).toBeUndefined();
    expect(() => recorder.check()).toThrow(/good \(call [^)]*\): .*no outputSchema/);
  });
});
