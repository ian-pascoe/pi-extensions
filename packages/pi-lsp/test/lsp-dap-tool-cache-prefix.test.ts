import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type AssistantMessage,
  type Context,
  type StreamFunction,
  type StreamOptions,
  type Tool,
} from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterEach, expect, test } from "vitest";
import { createPiLspExtension } from "../src/pi-lsp-extension.js";

const directories: string[] = [];
const sessions: AgentSession[] = [];

/**
 * One real Pi turn captured at the provider request boundary: the system prompt and ordered tool
 * definitions Pi handed to the stream, before any provider serializer touched them.
 */
interface TurnContext {
  readonly systemPrompt: string;
  readonly messages: Context["messages"];
  readonly tools: Tool[];
}

interface ToolCacheFixture {
  readonly session: AgentSession;
  readonly turns: TurnContext[];
  readonly responses: AssistantMessage[];
  readonly providerRequests: string[];
}

function deepSeekModel() {
  // The model from the reported defect: `openai-completions` against a provider that validates
  // tool schemas strictly, so the OpenAI-compatible serializer is the code path under test.
  const model = getModel("deepseek", "deepseek-v4-flash");
  if (model === undefined) throw new Error("Tool cache test: missing pinned DeepSeek model");
  return model;
}

/** Real Pi collaborators; the only scripted collaborator is the external model stream. */
async function createToolCacheFixture(
  toolNames: readonly ("lsp" | "dap")[],
): Promise<ToolCacheFixture> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-lsp-dap-cache-prefix-"));
  directories.push(cwd);
  const agentDir = join(cwd, "agent");
  await mkdir(agentDir);
  const settings = SettingsManager.inMemory({ retry: { enabled: false } });
  const projectModel = deepSeekModel();
  const providerRequests: string[] = [];
  // Load the sibling extension without widening this package's TypeScript rootDir.
  const {
    createPiDapExtension,
  }: {
    createPiDapExtension: (getAgentDirectory: () => string) => ExtensionFactory;
  } = await import(new URL("../../pi-dap/src/pi-dap-extension.js", import.meta.url).href);
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      ...toolNames.map((name) => ({
        name: `pi-${name}-cache-prefix-test`,
        factory:
          name === "lsp"
            ? createPiLspExtension({ getAgentDirectory: () => agentDir })
            : createPiDapExtension(() => agentDir),
      })),
      (pi) =>
        pi.registerProvider("deepseek", {
          api: "openai-completions",
          models: [projectModel],
          streamSimple(model) {
            providerRequests.push(model.id);
            throw new Error("Unexpected direct provider request (including a native summarizer)");
          },
        }),
    ],
    systemPromptOverride: () => "Standing instructions: answer with the shortest correct turn.",
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
    model: projectModel,
    modelRuntime,
    resourceLoader: loader,
    sessionManager: SessionManager.create(cwd, cwd),
    settingsManager: settings,
    noTools: "builtin",
  });
  sessions.push(session);

  const turns: TurnContext[] = [];
  const responses: AssistantMessage[] = [];
  session.agent.streamFunction = (currentModel, context, requestOptions) => {
    requestOptions?.signal?.throwIfAborted();
    turns.push({
      systemPrompt: context.systemPrompt ?? "",
      messages: structuredClone(context.messages),
      // Tool definitions carry live render/execute closures, so capture the serialized definition
      // exactly as the provider serializer reads it.
      tools: (context.tools ?? []).map(({ name, description, parameters }) => ({
        name,
        description,
        parameters: structuredClone(parameters),
      })),
    });
    const next = responses.shift();
    if (next === undefined) {
      throw new Error("Unexpected model request (including an accidental summarizer)");
    }
    const message: AssistantMessage = {
      ...next,
      api: currentModel.api,
      provider: currentModel.provider,
      model: currentModel.id,
    };
    const reason = message.stopReason;
    if (reason === "pending") throw new Error("Scripted response must be complete");
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      if (reason === "error" || reason === "aborted") {
        stream.push({ type: "error", reason, error: message });
      } else {
        stream.push({ type: "done", reason, message });
      }
    });
    return stream;
  };
  await session.bindExtensions({ mode: "rpc" });
  return { session, turns, responses, providerRequests };
}

const OpenAiCompletionsPayload = Type.Object(
  {
    model: Type.String(),
    messages: Type.Array(Type.Record(Type.String(), Type.Unknown()), { minItems: 1 }),
    tools: Type.Array(
      Type.Object(
        {
          type: Type.Literal("function"),
          function: Type.Object(
            {
              name: Type.String(),
              description: Type.String(),
              parameters: Type.Record(Type.String(), Type.Unknown()),
            },
            { additionalProperties: true },
          ),
        },
        { additionalProperties: true },
      ),
      { minItems: 1 },
    ),
  },
  { additionalProperties: true },
);

/**
 * Drive the installed OpenAI-compatible serializer and capture the payload it would transmit.
 *
 * The internal serializer is intentionally not exported. Pin this offline integration to the
 * installed implementation, never to a reference checkout or HTTP client: the `fetch` stub counts
 * every transport attempt and the sentinel aborts at `onPayload`, before any request is created.
 */
async function serializeTurn(turn: TurnContext) {
  const entry = import.meta.resolve("@earendil-works/pi-ai");
  const api: { stream: StreamFunction<"openai-completions", StreamOptions> } = await import(
    new URL("./api/openai-completions.js", entry).href
  );
  const sentinel = "STOP BEFORE DEEPSEEK TRANSPORT";
  let captured: unknown;
  let fetches = 0;
  const response = await api
    .stream(
      deepSeekModel(),
      {
        systemPrompt: turn.systemPrompt,
        messages: turn.messages,
        tools: turn.tools,
      },
      {
        apiKey: "TEST-NOT-A-REAL-KEY",
        fetch: async () => {
          fetches++;
          throw new Error("Unexpected network attempt");
        },
        sessionId: "lsp-dap-tool-cache-prefix",
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
  expect(fetches).toBe(0);
  if (!Value.Check(OpenAiCompletionsPayload, captured)) {
    throw new Error("Unexpected installed OpenAI-compatible payload");
  }
  return captured;
}

afterEach(async () => {
  for (const session of sessions.splice(0)) session.dispose();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/**
 * Issues #125 and #126: top-level unions made strict providers reject unrelated turns.
 * Test each extension alone and both together: schemas stay object-shaped, argument guidance
 * reaches the provider, and the ordered tool/system/history prefix stays stable across turns.
 */
test.each([{ toolNames: ["lsp"] }, { toolNames: ["dap"] }, { toolNames: ["lsp", "dap"] }] as const)(
  "serializes object-shaped $toolNames parameters and a stable prefix",
  async ({ toolNames }) => {
    const fixture = await createToolCacheFixture(toolNames);
    for (const name of toolNames) expect(fixture.session.getToolDefinition(name)).toBeDefined();

    fixture.responses.push(fauxAssistantMessage("Ready."));
    await fixture.session.prompt("Start");
    fixture.responses.push(fauxAssistantMessage("Still ready."));
    await fixture.session.prompt("Continue");
    expect(fixture.turns, "expected two consecutive real turns").toHaveLength(2);
    const [first, second] = fixture.turns;
    if (first === undefined || second === undefined) {
      throw new Error("Tool cache test: expected two captured turns");
    }

    const before = await serializeTurn(first);
    const after = await serializeTurn(second);

    // (a) Every registered tool reaches the provider as a root object, never a top-level union.
    expect(before.tools.map((tool) => tool.function.name)).toEqual(toolNames);
    for (const { function: tool } of before.tools) {
      expect(tool.description).toBe(fixture.session.getToolDefinition(tool.name)?.description);
      if (tool.name === "lsp") {
        expect(tool.description).toContain("format_document: file_path, tab_size, insert_spaces");
        expect(tool.description).toContain(
          "capabilities, restart, workspace_diagnostics: server_id, file_path",
        );
      } else {
        expect(tool.description).toContain(
          "variables: exactly one of frame_id or variables_reference is required (never both)",
        );
      }
      const parameters = tool.parameters;
      const observedSchema = JSON.stringify(parameters).slice(0, 400);
      expect(
        parameters.type,
        `registered ${tool.name} parameters must serialize as type "object"; got ${observedSchema}`,
      ).toBe("object");
      expect(
        Object.hasOwn(parameters, "anyOf"),
        `registered ${tool.name} parameters must not carry a top-level anyOf; got ${observedSchema}`,
      ).toBe(false);
      expect(parameters.required).toEqual(["operation"]);
      expect(parameters.additionalProperties).toBe(false);
    }

    // (b) Prefix stability: the ordered tool definitions and the system prompt are identical across
    // the two consecutive turns, so the fix does not reshuffle or destabilise the prompt prefix.
    expect(after.tools).toEqual(before.tools);
    expect(after.tools.map((tool) => tool.function.name)).toEqual(
      before.tools.map((tool) => tool.function.name),
    );
    expect(after.messages[0]).toEqual(before.messages[0]);
    expect(second.systemPrompt).toBe(first.systemPrompt);
    expect(after.messages.slice(0, before.messages.length)).toEqual(before.messages);

    // (c) Both turns were serialized offline: no transport was attempted and no direct provider
    // request escaped (the scripted stream is the only model collaborator).
    expect(fixture.providerRequests).toEqual([]);
  },
);
