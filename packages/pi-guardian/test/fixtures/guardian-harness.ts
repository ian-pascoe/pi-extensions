import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished } from "vitest";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  getCurrentSystemPrompt,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  withoutInitialSystemMessage,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type ToolCall,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type CreateAgentSessionOptions,
  type ExtensionAPI,
  type ExtensionFactory,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import guardian from "../../src/index.js";
import type { GuardianOptions } from "../../src/guardian-settings.js";

/** A scripted Guardian reply: assessment text, a provider failure, or a reply that waits. */
export type GuardianReply = string | Error | DeferredReply;

/** A Guardian reply produced later, for example after the review is aborted. */
export class DeferredReply {
  constructor(readonly run: (options: SimpleStreamOptions | undefined) => Promise<string>) {}
}

/** A captured Guardian request, as the provider received it. */
export interface CapturedReview {
  model: string;
  systemPrompt: string;
  messages: Context["messages"];
  options: SimpleStreamOptions | undefined;
}

export interface HarnessOptions {
  /** `guardian` settings in the global settings document. */
  guardianSettings?: GuardianOptions;
  /** Dialog-capable UI; omitted for headless (print) sessions. */
  ui?: Partial<ExtensionUIContext>;
  /** Mode bound with `ui`; the settings menu needs `tui`. */
  mode?: "tui" | "rpc";
  manager?: SessionManager;
  /** Extensions loaded before Guardian. */
  before?: ExtensionFactory[];
  /** Extensions loaded after Guardian. */
  after?: ExtensionFactory[];
  systemPrompt?: string;
  /** Leave Guardian out, to compare the Guarded Agent's requests with and without it. */
  withoutGuardian?: boolean;
  /** Activate Pi's built-in tools (`read`, `bash`, `edit`, `write`) on the temporary workspace. */
  builtinTools?: boolean;
  /** Context files as Pi's resource loader would provide them. */
  contextFiles?: (dir: string) => { path: string; content: string }[];
  /** Trust the temporary project. */
  projectTrusted?: boolean;
}

const offlineCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const agentModel: Model<"openai-completions"> = {
  id: "agent",
  name: "Agent",
  api: "openai-completions",
  provider: "guardian-test",
  baseUrl: "https://guardian.invalid",
  reasoning: false,
  input: ["text"],
  cost: offlineCost,
  contextWindow: 200_000,
  maxTokens: 2_048,
};

/**
 * Test tools: `deploy` has no annotations (reviewed), `lookup` is read-only, `script` nests calls
 * one at a time, and `batch` nests them concurrently.
 */
function testTools(executed: string[]): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: "deploy",
      label: "Deploy",
      description: "Deploy the given target.",
      parameters: Type.Object({ target: Type.String() }),
      execute: async (_id, args) => {
        executed.push(`deploy:${args.target}`);
        return { content: [{ type: "text", text: `deployed ${args.target}` }], details: {} };
      },
    });
    pi.registerTool({
      name: "lookup",
      label: "Lookup",
      description: "Look something up.",
      parameters: Type.Object({ query: Type.String() }),
      annotations: { readOnlyHint: true },
      execute: async (_id, args) => {
        executed.push(`lookup:${args.query}`);
        return { content: [{ type: "text", text: "found" }], details: {} };
      },
    });
    pi.registerTool({
      name: "script",
      label: "Script",
      description: "Run a script that deploys targets through nested tool calls.",
      parameters: Type.Object({ targets: Type.Array(Type.String()) }),
      annotations: { readOnlyHint: true },
      execute: async (_id, args, _signal, _onUpdate, ctx) => {
        const results = [];
        for (const target of args.targets)
          results.push(await ctx.executeTool("deploy", { target }));
        const text = results.map((result) => (result.isError ? "blocked" : "ran")).join(",");
        return { content: [{ type: "text", text }], details: {} };
      },
    });
    pi.registerTool({
      name: "batch",
      label: "Batch",
      description: "Deploy targets through concurrent nested tool calls.",
      parameters: Type.Object({ targets: Type.Array(Type.String()) }),
      annotations: { readOnlyHint: true },
      execute: async (_id, args, _signal, _onUpdate, ctx) => {
        const results = await Promise.all(
          args.targets.map((target) => ctx.executeTool("deploy", { target })),
        );
        const text = results.map((result) => (result.isError ? "blocked" : "ran")).join(",");
        return { content: [{ type: "text", text }], details: {} };
      },
    });
  };
}

/** Real Pi collaborators; the agent's and the Guardian's model replies are scripted. */
export async function createGuardianHarness(options: HarnessOptions = {}) {
  const dir = await mkdtemp(join(tmpdir(), "pi-guardian-test-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const manager = options.manager ?? SessionManager.create(dir, join(dir, "sessions"));
  const settings = SettingsManager.inMemory(
    { retry: { enabled: false }, compaction: { enabled: false } },
    { projectTrusted: options.projectTrusted ?? true },
  );
  if (options.guardianSettings)
    Object.defineProperty(settings, "getGlobalSettings", {
      value: () => ({ guardian: options.guardianSettings }),
    });
  const reviews: CapturedReview[] = [];
  const verdicts: GuardianReply[] = [];
  const executed: string[] = [];
  const loader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    agentsFilesOverride: (loaded) =>
      options.contextFiles ? { agentsFiles: options.contextFiles(dir) } : loaded,
    extensionFactories: [
      ...(options.before ?? []),
      testTools(executed),
      (pi) =>
        pi.registerProvider("guardian-test", {
          api: "openai-completions",
          apiKey: "offline",
          baseUrl: "https://guardian.invalid",
          models: ["agent", "reviewer"].map((id) => ({
            id,
            name: id,
            reasoning: id === "reviewer",
            input: ["text"],
            cost:
              id === "reviewer"
                ? { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }
                : offlineCost,
            contextWindow: 200_000,
            maxTokens: 2_048,
          })),
          streamSimple(model, context, requestOptions) {
            reviews.push({
              model: `${model.provider}/${model.id}`,
              systemPrompt: getCurrentSystemPrompt(context.messages),
              messages: structuredClone(withoutInitialSystemMessage(context.messages)),
              options: requestOptions,
            });
            const stream = createAssistantMessageEventStream();
            const verdict = verdicts.shift();
            const finish = (text: string) => {
              const message = {
                ...fauxAssistantMessage(text),
                api: model.api,
                provider: model.provider,
                model: model.id,
              };
              message.usage = {
                ...message.usage,
                input: 1_000,
                output: 50,
                totalTokens: 1_050,
                cost: { ...message.usage.cost, total: 0.0011 },
              };
              stream.push({ type: "done", reason: "stop", message });
            };
            const fail = (error: string, reason: "error" | "aborted") => {
              const message = {
                ...fauxAssistantMessage(""),
                api: model.api,
                provider: model.provider,
                model: model.id,
              };
              message.stopReason = reason;
              message.errorMessage = error;
              stream.push({ type: "error", reason, error: message });
            };
            queueMicrotask(() => {
              if (verdict === undefined) fail("No scripted Guardian reply", "error");
              else if (verdict instanceof Error) fail(verdict.message, "error");
              else if (verdict instanceof DeferredReply)
                verdict
                  .run(requestOptions)
                  .then(finish, (cause: unknown) =>
                    fail(cause instanceof Error ? cause.message : String(cause), "aborted"),
                  );
              else finish(verdict);
            });
            return stream;
          },
        }),
      ...(options.withoutGuardian ? [] : [guardian]),
      ...(options.after ?? []),
    ],
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
  const sessionOptions: CreateAgentSessionOptions = {
    cwd: dir,
    agentDir: dir,
    sessionManager: manager,
    settingsManager: settings,
    resourceLoader: loader,
    modelRuntime,
    model: agentModel,
  };
  if (!options.builtinTools) sessionOptions.noTools = "builtin";
  const { session } = await createAgentSession(sessionOptions);
  onTestFinished(() => {
    session.dispose();
  });
  const responses: AssistantMessage[] = [];
  const agentRequests: Context["messages"][] = [];
  /** The Guarded Agent's whole serialized requests: system prompt, ordered tools, and messages. */
  const agentContexts: string[] = [];
  session.agent.streamFunction = (currentModel, context) => {
    agentRequests.push(structuredClone(withoutInitialSystemMessage(context.messages)));
    // The transcript's system messages carry the system prompt and ordered tool declarations.
    agentContexts.push(JSON.stringify(context.messages));
    const next = responses.shift() ?? reply("Done.");
    const message = {
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
  const runner = session.extensionRunner;
  if (!runner) throw new Error("Missing extension runner");
  await session.bindExtensions(
    options.ui
      ? { mode: options.mode ?? "rpc", uiContext: { ...runner.getUIContext(), ...options.ui } }
      : { mode: "print" },
  );
  /** Custom entries of one type on the selected branch. */
  const entries = (customType: string) =>
    session.sessionManager
      .getBranch()
      .flatMap((entry) =>
        entry.type === "custom" && entry.customType === customType ? [entry.data] : [],
      );
  return {
    dir,
    manager,
    session,
    reviews,
    verdicts,
    responses,
    executed,
    agentRequests,
    agentContexts,
    entries,
  };
}

export function reply(text: string): AssistantMessage {
  return fauxAssistantMessage(text);
}

/** An assistant message calling tools, in order. */
export function toolCalls(
  ...calls: [name: string, args: ToolCall["arguments"], id: string][]
): AssistantMessage {
  return {
    ...fauxAssistantMessage(""),
    content: calls.map(([name, args, id]) => ({ type: "toolCall", name, arguments: args, id })),
    stopReason: "toolUse",
  };
}

/** A Guardian assessment reply. */
export function assessment(risk: string, authorization: string, rationale: string): string {
  return JSON.stringify({ risk_level: risk, user_authorization: authorization, rationale });
}
