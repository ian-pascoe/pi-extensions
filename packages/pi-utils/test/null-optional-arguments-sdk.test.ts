/* oxlint-disable anti-slop/no-unknown-parameters -- SAFETY: The probe tool receives arbitrary JSON arguments, as a model call delivers them. */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxToolCall,
  getCurrentSystemPrompt,
  getCurrentTools,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type AssistantMessage,
  type ToolCall,
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
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterEach, expect, test } from "vitest";
import { acceptNullForOptionalArguments } from "../src/null-optional-arguments.js";
import { toolDeclarations } from "../src/tool-testing.js";

const directories: string[] = [];
const sessions: AgentSession[] = [];

afterEach(async () => {
  for (const session of sessions.splice(0)) session.dispose();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const ProbeParameters = Type.Object(
  {
    path: Type.String(),
    depth: Type.Optional(Type.Integer({ minimum: 1 })),
    mode: Type.Optional(Type.Union([Type.Literal("fast"), Type.Literal("slow")])),
  },
  { additionalProperties: false },
);

/** Strict like pi-dap's parser: it throws on what the schema rejects, before Pi's validation. */
function strictProbeArguments(arguments_: unknown) {
  if (!Value.Check(ProbeParameters, arguments_)) {
    throw new Error(`invalid tool arguments: ${JSON.stringify(arguments_)}`);
  }
  return Value.Parse(ProbeParameters, arguments_);
}

interface Run {
  /** Ordered tool declarations and system prompt exactly as the provider receives them. */
  readonly declared: string;
  /** What `execute` received for each call, in order. */
  readonly executed: unknown[];
  readonly errors: string[];
}

/** One real Pi turn sequence; the only scripted collaborator is the external model stream. */
async function run(
  wrap: boolean,
  calls: readonly ToolCall["arguments"][],
  viaScript: boolean,
): Promise<Run> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-utils-null-optional-"));
  directories.push(cwd);
  const agentDir = join(cwd, "agent");
  await mkdir(agentDir);
  const executed: unknown[] = [];
  const probe = defineTool({
    name: "probe",
    label: "Probe",
    description: "Probe a path.",
    parameters: ProbeParameters,
    prepareArguments: strictProbeArguments,
    async execute(_id, input) {
      executed.push(input);
      return { content: [{ type: "text", text: "ok" }], details: undefined };
    },
  });
  const model = getModel("deepseek", "deepseek-flash");
  if (model === undefined) throw new Error("Missing pinned DeepSeek model");
  const settings = SettingsManager.inMemory({
    retry: { enabled: false },
    codemode: { mode: "on" },
    defaultTools: ["codemode"],
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
      (pi) => pi.registerTool(wrap ? acceptNullForOptionalArguments(probe) : probe),
      (pi) =>
        pi.registerProvider("deepseek", {
          api: "openai-completions",
          models: [model],
          streamSimple() {
            throw new Error("Unexpected direct provider request");
          },
        }),
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

  const responses: AssistantMessage[] = [
    ...calls.map((call) =>
      fauxAssistantMessage(
        viaScript
          ? fauxToolCall("codemode", { code: `return await tools.probe(${JSON.stringify(call)});` })
          : fauxToolCall("probe", call),
        { stopReason: "toolUse" },
      ),
    ),
    fauxAssistantMessage("Done."),
  ];
  const declarations: string[] = [];
  const errors: string[] = [];
  session.agent.streamFunction = (currentModel, context) => {
    // Each run has its own temporary directory, which the system prompt names.
    declarations.push(
      `${getCurrentSystemPrompt(context.messages)}\n${toolDeclarations(getCurrentTools(context.messages))}`.replaceAll(
        cwd,
        "<cwd>",
      ),
    );
    for (const message of context.messages) {
      if (message.role === "toolResult" && message.isError) {
        errors.push(
          message.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
        );
      }
    }
    const next = responses.shift();
    if (next === undefined) throw new Error("Unexpected model request");
    const message: AssistantMessage = {
      ...next,
      api: currentModel.api,
      provider: currentModel.provider,
      model: currentModel.id,
    };
    const reason = message.stopReason;
    if (reason === "pending" || reason === "error" || reason === "aborted") {
      throw new Error("Scripted response must finish normally");
    }
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => stream.push({ type: "done", reason, message }));
    return stream;
  };
  await session.bindExtensions({ mode: "rpc" });
  await session.prompt("Go");
  const [declared = ""] = declarations;
  // Every turn of the session declares the same prefix.
  expect(new Set(declarations).size).toBe(1);
  return { declared, executed, errors: [...new Set(errors)] };
}

const WITH_NULLS = [
  { path: "a", depth: null },
  { path: "b", depth: 2, mode: null },
  { path: "c", depth: null, mode: null },
];
const OMITTED = [{ path: "a" }, { path: "b", depth: 2 }, { path: "c" }];

test.each([
  { route: "a model tool call", viaScript: false },
  { route: "a codemode script call", viaScript: true },
])("$route with null for an optional parameter runs like omitting it", async ({ viaScript }) => {
  const omitted = await run(false, OMITTED, viaScript);
  expect(omitted.errors).toEqual([]);
  expect(omitted.executed).toEqual(OMITTED);

  const nulls = await run(true, WITH_NULLS, viaScript);
  expect(nulls.errors).toEqual([]);
  expect(nulls.executed).toEqual(OMITTED);
});

test.each([
  { route: "a model tool call", viaScript: false },
  { route: "a codemode script call", viaScript: true },
])("$route is rejected without the helper when the tool parses strictly", async ({ viaScript }) => {
  const rejected = await run(false, [{ path: "a", depth: null }], viaScript);
  expect(rejected.executed).toEqual([]);
  expect(rejected.errors.join("\n")).toContain("invalid tool arguments");
});

test("wrapping a tool leaves the provider-visible prefix byte-identical", async () => {
  const before = await run(false, OMITTED, false);
  const after = await run(true, WITH_NULLS, false);
  expect(after.declared).toBe(before.declared);
  // The declaration includes the optional parameters exactly as the bare tool declares them.
  expect(after.declared).toContain('"depth"');
  expect(after.declared).not.toContain('"null"');

  // The codemode catalog that scripts read is part of the same declaration.
  expect(after.declared).toContain("probe");
  const scripted = await run(true, WITH_NULLS, true);
  expect(scripted.declared).toBe(before.declared);
});
