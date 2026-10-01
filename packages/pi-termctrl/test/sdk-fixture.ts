import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type AssistantMessage,
  type Message,
  type Tool,
} from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import {
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionFactory,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import {
  createPiTermctrlExtension,
  type PiTermctrlExtensionOptions,
} from "../src/pi-termctrl-extension.js";
import type { TermctrlBinaryResolution } from "../src/termctrl-binary.js";
import type { TerminalDriver } from "../src/terminal-driver.js";

/** One real Pi turn captured at the provider boundary, before any serializer touched it. */
export interface CapturedTurn {
  readonly systemPrompt: string;
  readonly tools: Tool[];
  readonly messages: Message[];
}

/** Scripted model step: a fixed message or one computed from the turn's transcript. */
export type ScriptedResponse =
  | AssistantMessage
  | { readonly respond: (messages: readonly Message[]) => AssistantMessage };

/** JSON written to the fixture's global `settings.json`. */
export type SettingsJson =
  | string
  | number
  | boolean
  | null
  | readonly SettingsJson[]
  | { readonly [key: string]: SettingsJson };

/** The global `settings.json` document a fixture writes. */
interface FixtureSettings {
  [key: string]: SettingsJson;
}

export interface SdkFixtureOptions {
  readonly settings?: { readonly [key: string]: SettingsJson };
  readonly binary?: TermctrlBinaryResolution;
  readonly createDriver?: (binaryPath: string) => Promise<TerminalDriver>;
  readonly withTermctrl?: boolean;
  readonly extraFactories?: readonly ExtensionFactory[];
  readonly mode?: "rpc" | "print";
  /** Load Pi's built-in `codemode` extension and activate its tool. */
  readonly codemode?: boolean;
}

export interface SdkFixture {
  readonly session: AgentSession;
  readonly cwd: string;
  readonly turns: CapturedTurn[];
  readonly responses: ScriptedResponse[];
  readonly notifications: string[];
  readonly statuses: (string | undefined)[];
}

type InlineExtension = NonNullable<
  ConstructorParameters<typeof DefaultResourceLoader>[0]["extensionFactories"]
>[number];

const directories: string[] = [];
const sessions: AgentSession[] = [];

/** Real Pi collaborators; only the model stream is scripted. */
export async function createSdkFixture(options: SdkFixtureOptions = {}): Promise<SdkFixture> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-termctrl-sdk-"));
  directories.push(cwd);
  const agentDir = join(cwd, "agent");
  await mkdir(agentDir);
  const settings: FixtureSettings = {
    retry: { enabled: false },
    compaction: { enabled: false },
  };
  if (options.codemode === true) {
    settings["codemode"] = { mode: "on" };
    settings["defaultTools"] = ["read", "bash", "edit", "write", "codemode"];
  }
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({ ...settings, ...options.settings }),
  );

  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  const factories: InlineExtension[] = [];
  if (options.codemode === true) {
    factories.push({
      name: "codemode",
      factory: createCodemodeExtension(),
      builtin: true,
      replaceable: true,
    });
  }
  if (options.withTermctrl !== false) {
    const extensionOptions: PiTermctrlExtensionOptions = {
      getAgentDirectory: () => agentDir,
      resolveBinary: () => options.binary ?? { kind: "missing", reason: "test has no binary" },
    };
    factories.push({
      name: "pi-termctrl-test",
      factory: createPiTermctrlExtension(
        options.createDriver === undefined
          ? extensionOptions
          : { ...extensionOptions, createDriver: options.createDriver },
      ),
    });
  }
  for (const [index, factory] of (options.extraFactories ?? []).entries()) {
    factories.push({ name: `extra-${index}`, factory });
  }
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: options.codemode !== true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: factories,
    systemPromptOverride: () => "Standing instructions: answer with the shortest correct turn.",
  });
  await loader.reload();
  const errors = loader.getExtensions().errors;
  if (errors.length > 0) throw new Error(`extension load failed: ${JSON.stringify(errors)}`);

  const model = getModel("anthropic", "claude-sonnet-4-5");
  if (model === undefined) throw new Error("missing pinned model");
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: join(cwd, "models.json"),
    allowModelNetwork: false,
  });
  await modelRuntime.setRuntimeApiKey("anthropic", "TEST-NOT-A-REAL-KEY");
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model,
    modelRuntime,
    resourceLoader: loader,
    sessionManager: SessionManager.create(cwd, join(cwd, "sessions")),
    settingsManager,
  });
  sessions.push(session);

  const turns: CapturedTurn[] = [];
  const responses: ScriptedResponse[] = [];
  session.agent.streamFunction = (currentModel, context, requestOptions) => {
    requestOptions?.signal?.throwIfAborted();
    turns.push({
      systemPrompt: getCurrentSystemPrompt(context.messages),
      tools: getCurrentTools(context.messages).map(({ name, description, parameters }) => ({
        name,
        description,
        parameters: structuredClone(parameters),
      })),
      messages: structuredClone(context.messages),
    });
    const next = responses.shift();
    if (next === undefined) throw new Error("Unexpected model request");
    const scripted = "respond" in next ? next.respond(context.messages) : next;
    const message: AssistantMessage = {
      ...scripted,
      api: currentModel.api,
      provider: currentModel.provider,
      model: currentModel.id,
    };
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      const reason = message.stopReason;
      if (reason === "error" || reason === "aborted") {
        stream.push({ type: "error", reason, error: message });
      } else if (reason !== "pending") {
        stream.push({ type: "done", reason, message });
      }
    });
    return stream;
  };

  const notifications: string[] = [];
  const statuses: (string | undefined)[] = [];
  const base = session.extensionRunner.getUIContext();
  const uiContext: ExtensionUIContext = {
    ...base,
    notify: (message) => notifications.push(message),
    setStatus: (_key, text) => statuses.push(text),
  };
  await session.bindExtensions({ mode: options.mode ?? "rpc", uiContext });
  return { session, cwd, turns, responses, notifications, statuses };
}

/** Shut down every fixture session the way Pi does on quit, then delete its directories. */
export async function disposeSdkFixtures(): Promise<void> {
  for (const session of sessions.splice(0)) {
    try {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    } finally {
      session.dispose();
    }
  }
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
}

/** Wait until the session's agent is idle and no more scripted work is queued. */
export async function settle(session: AgentSession, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  await new Promise((resolve) => setTimeout(resolve, 20));
  while (session.isStreaming) {
    if (Date.now() > deadline) throw new Error("session did not settle");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
