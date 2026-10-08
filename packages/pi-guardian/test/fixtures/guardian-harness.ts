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
  type Api,
  type AssistantMessageEventStream,
  type ClassifierAnswer,
  type ClassifierContext,
  type ClassifierOptions,
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
import { streamSimple as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as streamBedrock } from "@earendil-works/pi-ai/api/bedrock-converse-stream";
import { streamSimple as streamOpenAICompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { Type } from "typebox";
import guardian from "../../src/index.js";
import type { GuardianOptions } from "../../src/guardian-settings.js";

/** A scripted Guardian reply: assessment text, a provider failure, or a reply that waits. */
export type GuardianReply = string | Error | DeferredReply | GatedReply;

/** A Guardian reply produced later, for example after the review is aborted. */
export class DeferredReply {
  constructor(readonly run: (options: SimpleStreamOptions | undefined) => Promise<string>) {}
}

/**
 * A Guardian reply the test paces by hand: the provider is called (`requested`), the stream
 * starts only on `begin()`, and the reply ends on `complete()` or `fail()`. Aborting the request
 * ends it as an aborted stream, as a real adapter does.
 */
export class GatedReply {
  /** Resolves when the provider is called with this reply. */
  readonly requested: Promise<void>;
  /** Set once the provider is called. */
  signal: AbortSignal | undefined;
  private markRequested: () => void = () => {};
  private startStream: () => void = () => {};
  private endStream: (error: string | undefined) => void = () => {};
  private begun = false;

  constructor(private readonly text = "") {
    this.requested = new Promise<void>((resolve) => {
      this.markRequested = resolve;
    });
  }

  /** Emit the stream's `start` event. */
  begin(): void {
    if (this.begun) return;
    this.begun = true;
    this.startStream();
  }

  /** Finish the stream with the scripted assessment. */
  complete(): void {
    this.begin();
    this.endStream(undefined);
  }

  /** Finish the stream with a provider error; before `begin()` it is the stream's first event. */
  fail(message: string): void {
    this.endStream(message);
  }

  /** @internal Called by the harness's provider. */
  serve(handlers: {
    signal: AbortSignal | undefined;
    start: () => void;
    finish: (text: string) => void;
    fail: (error: string, reason: "error" | "aborted") => void;
  }): void {
    this.signal = handlers.signal;
    this.startStream = handlers.start;
    this.endStream = (error) => {
      if (error === undefined) handlers.finish(this.text);
      else handlers.fail(error, "error");
    };
    handlers.signal?.addEventListener("abort", () => handlers.fail("aborted", "aborted"), {
      once: true,
    });
    if (this.begun) handlers.start();
    this.markRequested();
  }
}

/** A scripted classifier reply: answers by question, or a provider failure. */
export type ClassifierReply = Record<string, ClassifierAnswer> | Error | DeferredClassifierReply;

/** A classifier reply produced later, for example once a sibling's request has started. */
export class DeferredClassifierReply {
  constructor(readonly run: () => Promise<Record<string, ClassifierAnswer>>) {}
}

/** A captured classifier request, as the provider received it. */
export interface CapturedClassification {
  model: string;
  context: ClassifierContext;
  options: ClassifierOptions | undefined;
}

/** A captured Guardian request, as the provider received it. */
export interface CapturedReview {
  model: string;
  systemPrompt: string;
  messages: Context["messages"];
  options: SimpleStreamOptions | undefined;
  /** Whether this request is an Escalation Pass, which ends with the escalation instruction. */
  escalation: boolean;
  /**
   * With `wirePayloads`, the request body Pi's real provider adapter built for this call, before
   * and after the stream options' `onPayload` hook, as JSON text.
   */
  wire?: { built: string; sent: string } | undefined;
}

export interface HarnessOptions {
  /**
   * `guardian` settings in the global settings document. Guardian is disabled by default, so
   * these enable it unless they say otherwise; `null` leaves Guardian unconfigured.
   */
  guardianSettings?: GuardianOptions | null;
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
  /**
   * Prompt tokens the Guardian provider reports, given the request's chars/4 estimate (system
   * prompt and every text block); defaults to a fixed 1000 input tokens.
   */
  promptTokens?: (estimated: number) => number;
  /** Leave Guardian out, to compare the Guarded Agent's requests with and without it. */
  withoutGuardian?: boolean;
  /** Activate Pi's built-in tools (`read`, `bash`, `edit`, `write`) on the temporary workspace. */
  builtinTools?: boolean;
  /** Context files as Pi's resource loader would provide them. */
  contextFiles?: (dir: string) => { path: string; content: string }[];
  /** Trust the temporary project. */
  projectTrusted?: boolean;
  /**
   * Build each Guardian request with Pi's real provider adapter for the model's API and capture
   * the body it would send (see `CapturedReview.wire`); the reply is still scripted. Also adds the
   * reviewer models `guardian-anthropic/claude-haiku-4-5`, `guardian-anthropic/claude-haiku-5-5` (managed effort), and `guardian-bedrock/anthropic.claude-haiku-4-5-20251001-v1:0`.
   */
  wirePayloads?: boolean;
}

type ProviderStreamSimple = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

/** Pi's real provider adapter for the APIs a wire-level test builds requests with. */
function wireAdapter(api: Api): ProviderStreamSimple | undefined {
  switch (api) {
    case "anthropic-messages":
      // SAFETY: the adapter is only called with a model of its own API, which `api` selects.
      return streamAnthropic as ProviderStreamSimple;
    case "bedrock-converse-stream":
      // SAFETY: the adapter is only called with a model of its own API, which `api` selects.
      return streamBedrock as ProviderStreamSimple;
    case "openai-completions":
      // SAFETY: the adapter is only called with a model of its own API, which `api` selects.
      return streamOpenAICompletions as ProviderStreamSimple;
    default:
      return undefined;
  }
}

/**
 * Build `context` with the real adapter for `model`'s API and record the request body it would
 * send, before and after the `onPayload` hook, then stop before any network request.
 */
async function captureWire(
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions | undefined,
): Promise<CapturedReview["wire"]> {
  const adapter = wireAdapter(model.api);
  if (!adapter) throw new Error(`No wire adapter for ${model.api}`);
  let wire: CapturedReview["wire"];
  await adapter(model, context, {
    ...options,
    apiKey: "offline",
    onPayload: async (payload, payloadModel) => {
      const built = JSON.stringify(payload);
      const next = await options?.onPayload?.(payload, payloadModel);
      wire = { built, sent: JSON.stringify(next ?? payload) };
      throw new Error("Wire capture stops before the request is sent");
    },
  }).result();
  return wire;
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
  if (options.guardianSettings !== null) {
    const guardianSettings = { enabled: true, ...options.guardianSettings };
    Object.defineProperty(settings, "getGlobalSettings", {
      value: () => ({ guardian: guardianSettings }),
    });
  }
  const reviews: CapturedReview[] = [];
  const guardianReplies: GuardianReply[] = [];
  const classifications: CapturedClassification[] = [];
  const classifierReplies: ClassifierReply[] = [];
  const executed: string[] = [];
  const reviewerStream: ProviderStreamSimple = (model, context, requestOptions) => {
    const messages = structuredClone(withoutInitialSystemMessage(context.messages));
    const [first] = messages;
    const lastBlock =
      first?.role === "user" && Array.isArray(first.content) ? first.content.at(-1) : undefined;
    const captured: CapturedReview = {
      model: `${model.provider}/${model.id}`,
      systemPrompt: getCurrentSystemPrompt(context.messages),
      messages,
      options: requestOptions,
      escalation: lastBlock?.type === "text" && lastBlock.text.startsWith("Escalation:"),
    };
    reviews.push(captured);
    const wired = options.wirePayloads
      ? captureWire(model, context, requestOptions).then((wire) => {
          captured.wire = wire;
        })
      : undefined;
    const stream = createAssistantMessageEventStream();
    const scripted = guardianReplies.shift();
    const quarter = (text: string) => Math.ceil(text.length / 4);
    const estimated =
      quarter(getCurrentSystemPrompt(context.messages) ?? "") +
      withoutInitialSystemMessage(context.messages).reduce((sum, entry) => {
        if (entry.role !== "user") return sum;
        if (!Array.isArray(entry.content)) return sum + quarter(entry.content);
        return (
          sum +
          entry.content.reduce(
            (total, part) => total + (part.type === "text" ? quarter(part.text) : 0),
            0,
          )
        );
      }, 0);
    const reported = options.promptTokens?.(estimated) ?? 1_000;
    const finish = (text: string) => {
      const message = {
        ...fauxAssistantMessage(text),
        api: model.api,
        provider: model.provider,
        model: model.id,
      };
      message.usage = {
        ...message.usage,
        input: reported,
        output: 50,
        totalTokens: reported + 50,
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
    const begin = () => {
      stream.push({
        type: "start",
        partial: {
          ...fauxAssistantMessage(""),
          api: model.api,
          provider: model.provider,
          model: model.id,
        },
      });
    };
    const respond = () => {
      if (scripted instanceof GatedReply) {
        scripted.serve({ signal: requestOptions?.signal, start: begin, finish, fail });
        return;
      }
      // A provider streams `start` once its response begins; a failure may come before it.
      if (scripted !== undefined && !(scripted instanceof Error)) begin();
      if (scripted === undefined) fail("No scripted Guardian reply", "error");
      else if (scripted instanceof Error) fail(scripted.message, "error");
      else if (scripted instanceof DeferredReply)
        scripted
          .run(requestOptions)
          .then(finish, (cause: unknown) =>
            fail(cause instanceof Error ? cause.message : String(cause), "aborted"),
          );
      else finish(scripted);
    };
    if (wired) void wired.then(respond);
    else queueMicrotask(respond);
    return stream;
  };

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
      ...(options.wirePayloads
        ? [
            (pi: ExtensionAPI) => {
              for (const [provider, api, id] of [
                ["guardian-anthropic", "anthropic-messages", "claude-haiku-4-5"],
                [
                  "guardian-bedrock",
                  "bedrock-converse-stream",
                  "anthropic.claude-haiku-4-5-20251001-v1:0",
                ],
              ] as const)
                pi.registerProvider(provider, {
                  api,
                  apiKey: "offline",
                  baseUrl: "https://guardian.invalid",
                  models: [
                    {
                      id,
                      name: "reviewer",
                      reasoning: false,
                      input: ["text" as const],
                      cost: offlineCost,
                      contextWindow: 200_000,
                      maxTokens: 2_048,
                    },
                    // Managed effort: Pi's adapter appends empty system messages to the request.
                    ...(api === "anthropic-messages"
                      ? [
                          {
                            id: "claude-haiku-5-5",
                            name: "managed effort reviewer",
                            reasoning: false,
                            input: ["text" as const],
                            cost: offlineCost,
                            contextWindow: 200_000,
                            maxTokens: 2_048,
                            compat: { supportsMidConvoEffort: true, forceAdaptiveThinking: true },
                          },
                        ]
                      : []),
                  ],
                  streamSimple: reviewerStream,
                });
            },
          ]
        : []),
      (pi) =>
        pi.registerProvider("guardian-test", {
          api: "openai-completions",
          apiKey: "offline",
          baseUrl: "https://guardian.invalid",
          // `tiny` is a reviewer whose context window cannot hold a review; `judge` and
          // `tiny-judge` are classifiers, the latter too small to classify a review.
          models: [
            ...["agent", "reviewer", "tiny"].map((id) => ({
              id,
              name: id,
              reasoning: id === "reviewer",
              input: ["text" as const],
              cost:
                id === "reviewer"
                  ? { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }
                  : offlineCost,
              contextWindow: id === "tiny" ? 9_000 : 200_000,
              maxTokens: 2_048,
            })),
            ...["judge", "tiny-judge"].map((id) => ({
              type: "classifier" as const,
              id,
              name: id,
              api: "guardian-test-classify",
              input: ["text" as const],
              cost: offlineCost,
              contextWindow: id === "tiny-judge" ? 3_000 : 64_000,
            })),
          ],
          classifiers: {
            "guardian-test-classify": {
              async classify(model, context, requestOptions) {
                classifications.push({
                  model: `${model.provider}/${model.id}`,
                  context: structuredClone(context),
                  options: requestOptions,
                });
                const result = {
                  api: model.api,
                  provider: model.provider,
                  model: model.id,
                  timestamp: Date.now(),
                };
                const scripted = classifierReplies.shift();
                try {
                  if (scripted === undefined) throw new Error("No scripted classifier reply");
                  if (scripted instanceof Error) throw scripted;
                  const answers =
                    scripted instanceof DeferredClassifierReply ? await scripted.run() : scripted;
                  return {
                    ...result,
                    answers,
                    usage: {
                      input: 400,
                      output: 0,
                      cacheRead: 0,
                      cacheWrite: 0,
                      totalTokens: 400,
                      cost: {
                        input: 0.0001,
                        output: 0,
                        cacheRead: 0,
                        cacheWrite: 0,
                        total: 0.0001,
                      },
                    },
                    stopReason: "stop" as const,
                  };
                } catch (cause) {
                  return {
                    ...result,
                    answers: {},
                    stopReason: requestOptions?.signal?.aborted
                      ? ("aborted" as const)
                      : ("error" as const),
                    errorMessage: cause instanceof Error ? cause.message : String(cause),
                  };
                }
              },
            },
          },
          streamSimple: reviewerStream,
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
    guardianReplies,
    classifications,
    classifierReplies,
    responses,
    executed,
    agentRequests,
    agentContexts,
    entries,
  };
}

/**
 * Replies for a Rejection that its Escalation Pass confirms: the first pass's assessment, then the
 * same assessment again from the second pass.
 */
export function confirmedRejection(...args: Parameters<typeof assessment>): string[] {
  const text = assessment(...args);
  return [text, text];
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

/**
 * A Guardian assessment reply. `high` and `critical` risk name the `destruction` Risk Category
 * unless another is given; `null` leaves it out.
 */
export function assessment(
  risk: string,
  authorization: string,
  rationale: string,
  category: string | null = risk === "high" || risk === "critical" ? "destruction" : null,
): string {
  if (category === null)
    return JSON.stringify({ risk_level: risk, user_authorization: authorization, rationale });
  return JSON.stringify({
    risk_level: risk,
    user_authorization: authorization,
    risk_category: category,
    rationale,
  });
}

/** A `choice` answer over the given probabilities: the most likely option, with its confidence. */
export function choiceAnswer(probabilities: Record<string, number>): ClassifierAnswer {
  const entries = Object.entries(probabilities);
  let choice = "";
  let peak = -1;
  for (const [option, probability] of entries)
    if (probability > peak) [choice, peak] = [option, probability];
  const count = entries.length;
  return {
    type: "choice",
    choice,
    probabilities,
    confidence: Math.max(0, Math.min(1, (count * peak - 1) / (count - 1))),
  };
}

/** A classifier First Pass's answers by question. */
export type GuardianAnswers = {
  risk_level: ClassifierAnswer;
  user_authorization: ClassifierAnswer;
  risk_category: ClassifierAnswer;
};

/**
 * A classifier First Pass's answers: Risk Level, User Authorization, and Risk Category
 * distributions, each completed with zeros for the options left out.
 */
export function classified(
  risk: Record<string, number>,
  authorization: Record<string, number>,
  category: Record<string, number> = { none: 1 },
  categories: readonly string[] = [
    "data_egress",
    "credential_access",
    "destruction",
    "persistence",
    "sensitive_path",
    "safety_weakening",
    "remote_code",
    "unreviewed_execution",
  ],
): GuardianAnswers {
  const complete = (options: readonly string[], given: Record<string, number>) =>
    Object.fromEntries(options.map((option) => [option, given[option] ?? 0]));
  return {
    risk_level: choiceAnswer(complete(["low", "medium", "high", "critical"], risk)),
    user_authorization: choiceAnswer(complete(["unknown", "low", "medium", "high"], authorization)),
    risk_category: choiceAnswer(complete([...categories, "none"], category)),
  };
}
