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
import { expectToolOutputMatches, recordToolOutputs } from "../src/tool-testing.js";

const Output = Type.Object({ count: Type.Integer(), label: Type.String() });
const typed = { name: "typed", outputSchema: Output };
const untyped = { name: "untyped" };

describe("expectToolOutputMatches", () => {
  test("accepts a conforming result", () => {
    expect(() =>
      expectToolOutputMatches(typed, { structuredContent: { count: 1, label: "a" } }),
    ).not.toThrow();
  });

  test("accepts a tool without outputSchema whose result sets no structuredContent", () => {
    expect(() => expectToolOutputMatches(untyped, {})).not.toThrow();
    expect(() => expectToolOutputMatches(untyped, { isError: true })).not.toThrow();
  });

  test("rejects structuredContent from a tool that declares no outputSchema", () => {
    expect(() => expectToolOutputMatches(untyped, { structuredContent: { count: 1 } })).toThrow(
      /^untyped: .*no outputSchema.*codemode scripts would get the text/,
    );
    expect(() =>
      expectToolOutputMatches(untyped, { structuredContent: {}, isError: true }),
    ).toThrow(/untyped: .*no outputSchema/);
  });

  test("rejects a successful result without structuredContent from a tool with outputSchema", () => {
    expect(() => expectToolOutputMatches(typed, {})).toThrow(/^typed: .*no structuredContent/);
    expect(() => expectToolOutputMatches(typed, { isError: false })).toThrow(
      /^typed: .*no structuredContent/,
    );
  });

  test("lets an error result without structuredContent through", () => {
    expect(() => expectToolOutputMatches(typed, { isError: true })).not.toThrow();
  });

  test("checks an error result that carries structuredContent", () => {
    expect(() =>
      expectToolOutputMatches(typed, {
        structuredContent: { count: 1, label: "a" },
        isError: true,
      }),
    ).not.toThrow();
    expect(() =>
      expectToolOutputMatches(typed, { structuredContent: { count: "x" }, isError: true }),
    ).toThrow(/^typed: structuredContent violates/);
  });

  test("lists every schema violation by instance path", () => {
    let message = "";
    try {
      expectToolOutputMatches(typed, { structuredContent: { count: "x" } });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    const lines = message.split("\n");
    expect(lines[0]).toBe("typed: structuredContent violates its outputSchema:");
    // The missing `label` is reported at the root, the wrong `count` at its path.
    expect(lines.slice(1).some((line) => /^ {2}\/ .*label/.test(line))).toBe(true);
    expect(lines.slice(1).some((line) => /^ {2}\/count /.test(line))).toBe(true);
    expect(lines).toHaveLength(3);
  });

  test("reports a non-object structuredContent at the root", () => {
    expect(() => expectToolOutputMatches(typed, { structuredContent: "text" })).toThrow(/ {2}\/ /);
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
async function session(
  recorder: ReturnType<typeof recordToolOutputs>,
  before: ExtensionFactory[],
  turns: readonly AssistantMessage[],
) {
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
  return session;
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
    const recorder = recordToolOutputs();
    const running = await session(recorder, [], [script("good", "failing")]);
    expect(recorder.outputs.map(({ toolName }) => toolName).toSorted()).toEqual([
      "codemode",
      "failing",
      "good",
    ]);
    const nested = recorder.outputs.find(({ toolName }) => toolName === "good");
    expect(nested?.toolCallId).toContain("/");
    expect(nested?.structuredContent).toEqual({ count: 1, label: "good" });
    expect(() => recorder.check((name) => running.getToolDefinition(name))).not.toThrow();
  });

  test("reports every violation together, naming each tool and call", async () => {
    const recorder = recordToolOutputs();
    const running = await session(
      recorder,
      [],
      [script("good", "undeclared", "forgetful", "wrong")],
    );
    let message = "";
    try {
      recorder.check((name) => running.getToolDefinition(name));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/^3 tool result\(s\) do not conform/);
    expect(message).toMatch(/undeclared: .*no outputSchema/);
    expect(message).toMatch(/forgetful: .*no structuredContent/);
    expect(message).toMatch(/wrong: structuredContent violates[^]*\/count /);
    expect(message).not.toMatch(/good:/);
  });

  test("records and checks calls the model issues directly", async () => {
    const recorder = recordToolOutputs();
    const running = await session(
      recorder,
      [],
      [fauxAssistantMessage(fauxToolCall("undeclared", {}), { stopReason: "toolUse" })],
    );
    expect(
      recorder.outputs.map(({ toolCallId, toolName }) => [toolName, toolCallId.includes("/")]),
    ).toEqual([["undeclared", false]]);
    expect(() => recorder.check((name) => running.getToolDefinition(name))).toThrow(
      /undeclared: .*no outputSchema/,
    );
  });

  test("loaded last, it sees what an earlier handler left in the result", async () => {
    const recorder = recordToolOutputs();
    const running = await session(recorder, [breakingRedactor], [script("good")]);
    expect(recorder.outputs.find(({ toolName }) => toolName === "good")?.structuredContent).toEqual(
      { count: "redacted", label: "good" },
    );
    expect(() => recorder.check((name) => running.getToolDefinition(name))).toThrow(
      /good: structuredContent violates/,
    );
  });
});
