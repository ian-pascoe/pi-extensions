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
  getCurrentSystemPrompt,
  getCurrentTools,
  type StreamFunction,
  type StreamOptions,
  type Tool,
  type Message,
  normalizeContext,
} from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import {
  createAgentSession,
  createCodemodeExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type CreateAgentSessionOptions,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { withoutPreparedArguments } from "@ian-pascoe/pi-utils/tool-testing";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterEach, expect, test } from "vitest";
import { createPiLspExtension } from "../src/pi-lsp-extension.js";
import { LSP_OPERATION_NAMES } from "../src/lsp-tool-contract.js";
import { lspToolExposure } from "../src/lsp-tool.js";

const directories: string[] = [];
const sessions: AgentSession[] = [];

/**
 * One real Pi turn captured at the provider request boundary: the system prompt and ordered tool
 * definitions Pi handed to the stream, before any provider serializer touched them.
 */
interface TurnContext {
  readonly systemPrompt: string;
  /** The exact transcript, including Pi's system messages that declare prompt and tools. */
  readonly messages: Message[];
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
  const model = getModel("deepseek", "deepseek-flash");
  if (model === undefined) throw new Error("Tool cache test: missing pinned DeepSeek model");
  return model;
}

type ExtensionName = "lsp" | "dap";
/** Pi's built-in tool orchestrators, which list or load the LSP tools that are not declared. */
type BuiltinName = "codemode" | "tool_search";

interface ToolCacheOptions {
  readonly builtins?: readonly BuiltinName[];
  /** Entries for Pi's `defaultTools` setting; omitted, built-in tools are disabled. */
  readonly defaultTools?: readonly string[];
  /** Keep Pi's default system prompt, whose "Available tools" list shows prompt snippets. */
  readonly defaultSystemPrompt?: boolean;
  /** Register the tools without `prepareArguments`, as before they accepted null for optionals. */
  readonly withoutPreparedArguments?: boolean;
}

/** Real Pi collaborators; the only scripted collaborator is the external model stream. */
async function createToolCacheFixture(
  toolNames: readonly ExtensionName[],
  options: ToolCacheOptions = {},
): Promise<ToolCacheFixture> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-lsp-dap-cache-prefix-"));
  directories.push(cwd);
  const agentDir = join(cwd, "agent");
  await mkdir(agentDir);
  const builtins = options.builtins ?? [];
  const defaultTools = options.defaultTools ?? (builtins.length === 0 ? undefined : [...builtins]);
  const settingsData: NonNullable<Parameters<typeof SettingsManager.inMemory>[0]> = {
    retry: { enabled: false },
    codemode: { mode: "on" },
  };
  if (defaultTools !== undefined) settingsData.defaultTools = [...defaultTools];
  const settings = SettingsManager.inMemory(settingsData);
  const projectModel = deepSeekModel();
  const providerRequests: string[] = [];
  // Load the sibling extension without widening this package's TypeScript rootDir.
  const {
    createPiDapExtension,
  }: {
    createPiDapExtension: (getAgentDirectory: () => string) => ExtensionFactory;
  } = await import(new URL("../../pi-dap/src/pi-dap-extension.js", import.meta.url).href);
  const loaderOptions: ConstructorParameters<typeof DefaultResourceLoader>[0] = {
    cwd,
    agentDir,
    settingsManager: settings,
    noExtensions: builtins.length === 0,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      ...builtins.map((name) => ({
        name: name === "codemode" ? "codemode" : "tool-search",
        factory: name === "codemode" ? createCodemodeExtension() : createToolSearchExtension(),
        builtin: true,
        replaceable: true,
      })),
      ...toolNames.map((name) => {
        const factory =
          name === "lsp"
            ? createPiLspExtension({ getAgentDirectory: () => agentDir })
            : createPiDapExtension(() => agentDir);
        return {
          name: `pi-${name}-cache-prefix-test`,
          factory: options.withoutPreparedArguments ? withoutPreparedArguments(factory) : factory,
        };
      }),
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
  };
  if (options.defaultSystemPrompt !== true) {
    loaderOptions.systemPromptOverride = () =>
      "Standing instructions: answer with the shortest correct turn.";
  }
  const loader = new DefaultResourceLoader(loaderOptions);
  await loader.reload();
  expect(loader.getExtensions().errors).toEqual([]);

  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: join(cwd, "models.json"),
    allowModelNetwork: false,
  });
  await modelRuntime.setRuntimeApiKey("deepseek", "TEST-NOT-A-REAL-KEY");
  const sessionOptions: CreateAgentSessionOptions = {
    cwd,
    agentDir,
    model: projectModel,
    modelRuntime,
    resourceLoader: loader,
    sessionManager: SessionManager.create(cwd, cwd),
    settingsManager: settings,
  };
  // Without `defaultTools`, disable built-in tools so only the extensions' tools are declared.
  if (defaultTools === undefined) sessionOptions.noTools = "builtin";
  const { session } = await createAgentSession(sessionOptions);
  sessions.push(session);

  const turns: TurnContext[] = [];
  const responses: AssistantMessage[] = [];
  session.agent.streamFunction = (currentModel, context, requestOptions) => {
    requestOptions?.signal?.throwIfAborted();
    turns.push({
      systemPrompt: getCurrentSystemPrompt(context.messages),
      messages: structuredClone(context.messages),
      // Capture the ordered tool declarations exactly as the provider serializer reads them.
      tools: getCurrentTools(context.messages).map(({ name, description, parameters }) => ({
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
    .stream(deepSeekModel(), normalizeContext({ messages: turn.messages }), {
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
    })
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

/** The LSP tools Pi declares to the model by default (ADR-0003), in registration order. */
const DIRECT_LSP_TOOLS = LSP_OPERATION_NAMES.filter(
  (operation) => lspToolExposure(operation) === "direct",
).map((operation) => `lsp_${operation}`);

/** The twelve per-operation DAP tools, all declared directly (pi-dap ADR-0002). */
const DAP_TOOLS = [
  "dap_launch",
  "dap_set_breakpoints",
  "dap_continue",
  "dap_next",
  "dap_step_in",
  "dap_step_out",
  "dap_pause",
  "dap_stack",
  "dap_variables",
  "dap_evaluate",
  "dap_status",
  "dap_stop",
];

test("declares lsp_status directly for the troubleshooting Skill", () => {
  expect(DIRECT_LSP_TOOLS).toEqual([
    "lsp_status",
    "lsp_diagnostics",
    "lsp_hover",
    "lsp_goto_definition",
    "lsp_find_references",
    "lsp_document_symbols",
    "lsp_workspace_symbols",
    "lsp_rename",
    "lsp_code_actions",
    "lsp_apply",
  ]);
});

function declaredToolNames(toolNames: readonly ExtensionName[]): string[] {
  return toolNames.flatMap((name) => (name === "lsp" ? DIRECT_LSP_TOOLS : DAP_TOOLS));
}

function systemMessageCount(messages: readonly Message[]): number {
  return messages.filter((message) => message.role === "system").length;
}

/**
 * Prove the cache prefix is stable: every turn, including after `/reload`, hands the provider
 * byte-identical ordered tool definitions (names, descriptions, parameters) and system prompt, and
 * each transcript is an append-only extension of the previous one with no mid-conversation system
 * message that would add, remove, or patch tools.
 */
function expectStablePrefix(turns: readonly TurnContext[]): void {
  const [first] = turns;
  if (first === undefined) throw new Error("Tool cache test: no captured turns");
  expect(systemMessageCount(first.messages)).toBe(1);
  for (const [index, turn] of turns.entries()) {
    const previous = turns[index - 1];
    if (previous === undefined) continue;
    expect(JSON.stringify(turn.tools), `tools of turn ${index}`).toBe(JSON.stringify(first.tools));
    expect(turn.systemPrompt, `system prompt of turn ${index}`).toBe(first.systemPrompt);
    expect(
      JSON.stringify(turn.messages.slice(0, previous.messages.length)),
      `transcript prefix of turn ${index}`,
    ).toBe(JSON.stringify(previous.messages));
    expect(systemMessageCount(turn.messages), `system messages in turn ${index}`).toBe(1);
  }
}

/** Two turns, `/reload`, and a third turn. */
async function runTurnsAcrossReload(fixture: ToolCacheFixture): Promise<readonly TurnContext[]> {
  fixture.responses.push(
    fauxAssistantMessage("Ready."),
    fauxAssistantMessage("Still ready."),
    fauxAssistantMessage("Reloaded."),
  );
  await fixture.session.prompt("Start");
  await fixture.session.prompt("Continue");
  await fixture.session.reload();
  await fixture.session.prompt("After reload");
  expect(fixture.turns, "expected three real turns").toHaveLength(3);
  return fixture.turns;
}

/**
 * Issues #125 and #126: top-level unions made strict providers reject unrelated turns.
 * Test each extension alone and both together: schemas stay object-shaped, argument guidance
 * reaches the provider, and the ordered tool/system/history prefix stays stable across turns and
 * `/reload`.
 */
test.each([{ toolNames: ["lsp"] }, { toolNames: ["dap"] }, { toolNames: ["lsp", "dap"] }] as const)(
  "serializes object-shaped $toolNames parameters and a stable prefix",
  async ({ toolNames }) => {
    const fixture = await createToolCacheFixture(toolNames);
    const declared = declaredToolNames(toolNames);
    for (const name of declared) expect(fixture.session.getToolDefinition(name)).toBeDefined();
    const turns = await runTurnsAcrossReload(fixture);
    const [first, second, third] = turns;
    if (first === undefined || second === undefined || third === undefined) {
      throw new Error("Tool cache test: expected three captured turns");
    }

    const before = await serializeTurn(first);
    const after = await serializeTurn(second);
    const reloaded = await serializeTurn(third);

    // (a) Only the direct LSP and DAP tools are declared, each as a root object with its own fields.
    expect(before.tools.map((tool) => tool.function.name)).toEqual(declared);
    for (const { function: tool } of before.tools) {
      expect(tool.description).toBe(fixture.session.getToolDefinition(tool.name)?.description);
      if (tool.name === "dap_variables") {
        expect(tool.description).toContain(
          "Exactly one of frame_id (the scopes of a Stack Frame; expensive scopes such as Global are listed but not expanded) or variables_reference (children of a value or of an unexpanded scope) is required, never both",
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
      expect(parameters.additionalProperties).toBe(false);
    }
    const hover = before.tools.find(({ function: tool }) => tool.name === "lsp_hover");
    if (hover !== undefined) {
      expect(hover.function.parameters.required).toEqual(["file_path", "line", "character"]);
    }

    // `lsp_document_symbols` declares its optional `depth` as a property of the root object, with
    // guidance, so the changed definition stays object-shaped and `file_path` stays the only
    // required field.
    const symbols = before.tools.find(({ function: tool }) => tool.name === "lsp_document_symbols");
    if (symbols !== undefined) {
      expect(symbols.function.parameters).toMatchObject({
        required: ["file_path"],
        properties: {
          depth: {
            anyOf: [{ type: "integer", minimum: 1 }, { const: "all" }],
            description: expect.stringMatching(/default 1.*without import bindings/),
          },
        },
      });
    }

    // (b) Prefix stability across turns and reload: identical ordered tool definitions, system
    // prompt, and append-only history, both as Pi hands them over and as the provider serializes.
    expectStablePrefix(turns);
    expect(after.tools).toEqual(before.tools);
    expect(reloaded.tools).toEqual(before.tools);
    expect(after.messages[0]).toEqual(before.messages[0]);
    expect(reloaded.messages[0]).toEqual(before.messages[0]);
    expect(after.messages.slice(0, before.messages.length)).toEqual(before.messages);
    expect(reloaded.messages.slice(0, after.messages.length)).toEqual(after.messages);

    // (c) Every turn was serialized offline: no transport was attempted and no direct provider
    // request escaped (the scripted stream is the only model collaborator).
    expect(fixture.providerRequests).toEqual([]);
  },
);

/**
 * With Pi's codemode and tool_search active, the long-tail LSP tools are listed once in the
 * codemode description under the `lsp` namespace, and the declared LSP tools say what scripts
 * receive. Neither listing changes across turns or `/reload`.
 */
test.each([
  { toolNames: ["lsp"], builtins: ["codemode"] },
  { toolNames: ["lsp", "dap"], builtins: ["codemode", "tool_search"] },
] as const)(
  "keeps $toolNames with $builtins byte-stable across turns and reload",
  async ({ toolNames, builtins }) => {
    const fixture = await createToolCacheFixture(toolNames, { builtins });
    const turns = await runTurnsAcrossReload(fixture);
    expectStablePrefix(turns);
    const tools = turns[0]?.tools ?? [];
    expect(tools.map(({ name }) => name)).toEqual([...builtins, ...declaredToolNames(toolNames)]);

    const codemode = tools.find(({ name }) => name === "codemode")?.description ?? "";
    expect(codemode).toContain("## lsp");
    expect(codemode).toContain("Language-server navigation, diagnostics, and previewed edits");
    // Long-tail tools are listed; declared ones, including lsp_status, are not repeated.
    expect(codemode).toContain("lsp_capabilities");
    expect(codemode).not.toContain("lsp_status");
    expect(codemode).not.toContain("lsp_hover(");
    const hover = tools.find(({ name }) => name === "lsp_hover")?.description ?? "";
    expect(hover).toContain(
      "Codemode: `tools.lsp_hover(args)` resolves to `{ position, results, warnings, truncated, structured_truncated, spill_path?, server_preview_ids? }`.",
    );
    expect(fixture.providerRequests).toEqual([]);
  },
);

test("lists the lsp_* family once in the default system prompt and keeps it stable", async () => {
  const fixture = await createToolCacheFixture(["lsp"], { defaultSystemPrompt: true });
  const turns = await runTurnsAcrossReload(fixture);
  expectStablePrefix(turns);
  const prompt = turns[0]?.systemPrompt ?? "";
  // One snippet: a single line in "Available tools" names the family; the other tools have none.
  expect(prompt).toContain(
    "- lsp_diagnostics: Language-server diagnostics; the lsp_* tools also cover navigation and previewed edits",
  );
  expect(prompt.match(/^- lsp_\w+:/gmu)).toEqual(["- lsp_diagnostics:"]);
});

test("activates a codemode-exposure LSP tool by name through defaultTools", async () => {
  const fixture = await createToolCacheFixture(["lsp"], {
    defaultTools: ["+lsp_workspace_diagnostics"],
  });
  const turns = await runTurnsAcrossReload(fixture);
  expectStablePrefix(turns);
  expect(turns[0]?.tools.map(({ name }) => name)).toEqual([
    "read",
    "bash",
    "edit",
    "write",
    // Named tools activate in `defaultTools` order, then direct tools in registration order.
    "lsp_workspace_diagnostics",
    ...DIRECT_LSP_TOOLS,
  ]);
});

test("a codemode script receives the structured result of an LSP tool", async () => {
  const fixture = await createToolCacheFixture(["lsp"], { builtins: ["codemode"] });
  fixture.responses.push(
    fauxAssistantMessage(
      fauxToolCall("codemode", {
        code: "const status = await tools.lsp_status({});\nreturn { servers: status.servers.length, truncated: status.truncated, kind: typeof status };",
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Done."),
  );
  await fixture.session.prompt("Check the language servers from a script");
  const result = fixture.turns[1]?.messages.findLast(
    (message) => message.role === "toolResult" && message.toolName === "codemode",
  );
  if (result?.role !== "toolResult") throw new Error("Expected a codemode result");
  const text = result.content.map((item) => (item.type === "text" ? item.text : "")).join("");
  expect(text).toContain("Script completed");
  expect(text).toContain('"servers":0');
  expect(text).toContain('"truncated":false');
  expect(text).toContain('"kind":"object"');
});

/**
 * Accepting null for optional parameters adds only `prepareArguments`, which Pi never sends to the
 * provider: with and without it, every turn hands the provider byte-identical ordered tool
 * definitions (including the codemode catalog of the long-tail LSP tools), system prompt, and
 * history, across turns and `/reload`.
 */
test.each([{ builtins: [] }, { builtins: ["codemode", "tool_search"] }] as const)(
  "declares the same ordered tools with and without null handling (builtins: $builtins)",
  async ({ builtins }) => {
    const run = async (stripped: boolean) => {
      const fixture = await createToolCacheFixture(["lsp", "dap"], {
        builtins,
        withoutPreparedArguments: stripped,
      });
      const turns = await runTurnsAcrossReload(fixture);
      expectStablePrefix(turns);
      const directory = fixture.session.sessionManager.getCwd();
      return JSON.stringify(
        turns.map(({ systemPrompt, tools, messages }) => ({
          systemPrompt,
          tools,
          messages: messages.map((message) => ({ ...message, timestamp: undefined })),
        })),
      ).replaceAll(directory, "<dir>");
    };
    const before = await run(true);
    const after = await run(false);
    expect(after).toContain('"name":"lsp_document_symbols"');
    expect(after).toBe(before);
  },
);
