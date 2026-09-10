import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type AssistantMessage,
  type Context,
  type ToolCall,
} from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionFactory,
  type ExtensionError,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";

interface HarnessOptions {
  contextSettings?: Partial<import("../src/context-settings.js").ContextSettings>;
  settings?: SettingsManager;
  contextWindow?: number;
  maxTokens?: number;
  reserveTokens?: number;
  keepRecentTokens?: number;
  systemPrompt?: string;
  manager?: SessionManager;
  additionalExtensionPaths?: string[];
}

/** Real Pi collaborators; the only scripted collaborator is the external model stream. */
export async function createSdkHarness(
  extensions: ExtensionFactory[],
  options: HarnessOptions = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "pi-context-test-"));
  const manager = options.manager ?? SessionManager.create(dir, dir);
  const document = {
    contextManagement: options.contextSettings,
    compaction: {
      enabled: true,
      keepRecentTokens: options.keepRecentTokens ?? 1,
      reserveTokens: options.reserveTokens ?? 512,
    },
    retry: { enabled: false },
  };
  const settings = options.settings ?? SettingsManager.inMemory(document);
  const baseModel = getModel("anthropic", "claude-sonnet-4-5");
  const model = {
    ...baseModel,
    contextWindow: options.contextWindow ?? 200_000,
    maxTokens: options.maxTokens ?? 512,
  };
  const providerRequests: string[] = [];
  const loader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      ...extensions,
      (pi) =>
        pi.registerProvider("anthropic", {
          api: "anthropic-messages",
          models: [model],
          streamSimple(model) {
            providerRequests.push(model.id);
            throw new Error("Unexpected direct provider request (including a native summarizer)");
          },
        }),
    ],
    additionalExtensionPaths: options.additionalExtensionPaths ?? [],
    systemPromptOverride: () =>
      options.systemPrompt ?? "Standing instructions: finish the user's task.",
  });
  await loader.reload();
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: join(dir, "models.json"),
    allowModelNetwork: false,
  });
  await modelRuntime.setRuntimeApiKey("anthropic", "TEST-NOT-A-REAL-KEY");
  const { session } = await createAgentSession({
    cwd: dir,
    agentDir: dir,
    sessionManager: manager,
    settingsManager: settings,
    resourceLoader: loader,
    modelRuntime,
    model,
    noTools: "builtin",
  });
  afterEach(async () => {
    session.dispose();
    await rm(dir, { recursive: true, force: true });
  });
  const events: AgentSessionEvent[] = [];
  session.subscribe((event) => events.push(event));
  const requests: Array<{
    systemPrompt: string;
    messages: Context["messages"];
    tools: string[];
    toolDefinitions: Context["tools"];
  }> = [];
  const responses: AssistantMessage[] = [];
  session.agent.streamFunction = (currentModel, context, requestOptions) => {
    requestOptions?.signal?.throwIfAborted();
    requests.push({
      systemPrompt: context.systemPrompt ?? "",
      messages: structuredClone(context.messages),
      tools: (context.tools ?? []).map((tool) => tool.name),
      toolDefinitions: context.tools?.map(({ name, description, parameters }) => ({
        name,
        description,
        parameters: structuredClone(parameters),
      })),
    });
    const next = responses.shift();
    if (!next) throw new Error("Unexpected model request (including an accidental summarizer)");
    const message = {
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
      } else stream.push({ type: "done", reason, message });
    });
    return stream;
  };
  const extensionErrors: ExtensionError[] = [];
  // RPC supplies an error listener too; bindings make /reload emit session_start.
  await session.bindExtensions({ mode: "rpc", onError: (error) => extensionErrors.push(error) });
  return {
    dir,
    manager,
    settings,
    session,
    requests,
    responses,
    events,
    providerRequests,
    extensionErrors,
  };
}

export function reply(text: string, inputTokens = 100): AssistantMessage {
  const message = fauxAssistantMessage(text);
  message.usage = {
    ...message.usage,
    cost: { ...message.usage.cost },
    input: inputTokens,
    output: 10,
    totalTokens: inputTokens + 10,
  };
  return message;
}

export function toolCall(
  name: string,
  args: ToolCall["arguments"],
  id = "call-1",
): AssistantMessage {
  return {
    ...reply(""),
    content: [{ type: "toolCall", name, arguments: args, id }],
    stopReason: "toolUse",
  };
}
