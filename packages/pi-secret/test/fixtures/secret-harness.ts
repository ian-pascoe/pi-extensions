import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { Value } from "typebox/value";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished } from "vitest";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  withoutInitialSystemMessage,
  type AssistantMessage,
  type Context,
  type JsonValue,
  type ToolCall,
} from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
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
import { getKeybindings, type Component } from "@earendil-works/pi-tui";
import { taggedTheme } from "@ian-pascoe/pi-utils/ui-testing";
import { Type } from "typebox";
import { createPiSecretExtension, type ProviderContext } from "../../src/pi-secret-extension.js";
import type { SecretProvider } from "../../src/secret-provider.js";

/** Raw terminal input, one element per keypress or paste, typed into one Secret Request dialog. */
export type DialogScript = readonly string[];

export const keys = {
  enter: "\r",
  escape: "\x1b",
  tab: "\t",
  shiftTab: "\x1b[Z",
  backspace: "\x7f",
  paste: (text: string) => `\x1b[200~${text}\x1b[201~`,
} as const;

/** A mutable clock the extension reads, so tests can pass a Secret Lifetime instantly. */
export interface TestClock {
  now: number;
}

export interface SecretHarnessOptions {
  /** One script per `secret_ask` dialog, in order. */
  dialogs?: DialogScript[];
  /** Bind without dialog-capable UI, as print mode and Child Agents do. */
  headless?: boolean;
  /** Global Pi settings written to the agent directory. */
  settings?: Record<string, JsonValue>;
  /** Project Pi settings written to the workspace's `.pi/settings.json`. */
  projectSettings?: Record<string, JsonValue>;
  /** Reuse a workspace (cwd and agent directory) from an earlier harness. */
  dir?: string;
  /** Open an existing session file instead of creating one. */
  sessionFile?: string;
  clock?: TestClock;
  /** Activate Pi's built-in tools on the workspace. */
  builtinTools?: boolean;
  /** Extensions loaded before Pi Secret. */
  before?: ExtensionFactory[];
  /**
   * Secret Providers, or a factory given the extension's provider context; none by default, so
   * tests never reach a real 1Password CLI.
   */
  providers?: SecretProvider[] | ((context: ProviderContext) => SecretProvider[]);
}

/** What a test tool received, after every `tool_call` handler ran. */
export interface ReceivedCall {
  tool: string;
  args: ToolCall["arguments"];
}

/** Tools that record the arguments they receive and echo them back in every result field. */
function testTools(received: ReceivedCall[]): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: "echo",
      label: "Echo",
      description: "Echo text back.",
      parameters: Type.Object({ text: Type.String() }),
      async execute(_id, params) {
        received.push({ tool: "echo", args: structuredClone(params) });
        return {
          content: [{ type: "text", text: `echo: ${params.text}` }],
          details: { text: params.text },
          structuredContent: { text: params.text },
        };
      },
    });
    pi.registerTool({
      name: "spill",
      label: "Spill",
      description: "Write text to a full output file and point at it.",
      parameters: Type.Object({ text: Type.String(), path: Type.String() }),
      async execute(_id, params) {
        received.push({ tool: "spill", args: structuredClone(params) });
        await writeFile(params.path, params.text);
        return {
          content: [{ type: "text", text: "spilled" }],
          details: { fullOutputPath: params.path },
          structuredContent: { full_output_path: params.path },
        };
      },
    });
    pi.registerTool({
      name: "unreadable",
      label: "Unreadable",
      description: "Return details that cannot be read.",
      parameters: Type.Object({}),
      async execute() {
        received.push({ tool: "unreadable", args: {} });
        const details = {};
        Object.defineProperty(details, "broken", {
          enumerable: true,
          get() {
            throw new Error("unreadable details");
          },
        });
        return { content: [{ type: "text", text: "unreadable" }], details };
      },
    });
  };
}

/** A `secret_*` tool's result as Pi Secret leaves it, after redaction. */
export interface RecordedValue {
  tool: string;
  structuredContent: JsonValue | undefined;
  isError: boolean;
}

/** Records each `secret_*` result's `structuredContent`, which the transcript does not keep. */
function valueRecorder(values: Map<string, RecordedValue>): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.on("tool_result", (event) => {
      if (!event.toolName.startsWith("secret_")) return;
      values.set(event.toolCallId, {
        tool: event.toolName,
        structuredContent: structuredClone(event.structuredContent),
        isError: event.isError,
      });
    });
  };
}

/** One rendered frame of a dialog, after its opening render or a keypress. */
export type DialogFrame = string[];

export async function createSecretHarness(options: SecretHarnessOptions = {}) {
  const dir = options.dir ?? (await mkdtemp(join(tmpdir(), "pi-secret-")));
  if (!options.dir)
    onTestFinished(async () => {
      await rm(dir, { recursive: true, force: true });
    });
  await writeFile(
    join(dir, "settings.json"),
    JSON.stringify({
      compaction: { enabled: false },
      retry: { enabled: false },
      ...options.settings,
    }),
  );
  if (options.projectSettings !== undefined) {
    await mkdir(join(dir, ".pi"), { recursive: true });
    await writeFile(join(dir, ".pi", "settings.json"), JSON.stringify(options.projectSettings));
  }
  // Starts at the real time: other sessions in the process judge expiry by the wall clock.
  const clock = options.clock ?? { now: Date.now() };
  const received: ReceivedCall[] = [];
  const values = new Map<string, RecordedValue>();
  const dialogs = [...(options.dialogs ?? [])];
  const frames: DialogFrame[] = [];
  const notices: string[] = [];
  const loader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    settingsManager: SettingsManager.create(dir, dir),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      ...(options.before ?? []),
      testTools(received),
      createPiSecretExtension({
        getAgentDirectory: () => dir,
        now: () => clock.now,
        providers: (context) => {
          const providers = options.providers ?? [];
          return Array.isArray(providers) ? providers : providers(context);
        },
      }),
      // After Pi Secret, so it records the value scripts receive: redacted.
      valueRecorder(values),
    ],
    systemPromptOverride: () => "Standing instructions: finish the user's task.",
  });
  await loader.reload();
  const loadErrors = loader.getExtensions().errors;
  if (loadErrors.length > 0) throw new Error(JSON.stringify(loadErrors));
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: join(dir, "models.json"),
    allowModelNetwork: false,
  });
  await modelRuntime.setRuntimeApiKey("anthropic", "TEST-NOT-A-REAL-KEY");
  const manager = options.sessionFile
    ? SessionManager.open(options.sessionFile, join(dir, "sessions"))
    : SessionManager.create(dir, join(dir, "sessions"));
  const sessionOptions: CreateAgentSessionOptions = {
    cwd: dir,
    agentDir: dir,
    sessionManager: manager,
    settingsManager: SettingsManager.create(dir, dir),
    resourceLoader: loader,
    modelRuntime,
    model: getModel("anthropic", "claude-sonnet-4-5"),
  };
  if (!options.builtinTools) sessionOptions.noTools = "builtin";
  const { session } = await createAgentSession(sessionOptions);
  onTestFinished(() => {
    session.dispose();
  });

  const responses: AssistantMessage[] = [];
  /** Every provider request's messages, as serialized JSON. */
  const requests: string[] = [];
  const requestMessages: Context["messages"][] = [];
  session.agent.streamFunction = (currentModel, context) => {
    requests.push(JSON.stringify(context));
    requestMessages.push(structuredClone(withoutInitialSystemMessage(context.messages)));
    const next = responses.shift() ?? fauxAssistantMessage("Done.");
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

  const ui: Partial<ExtensionUIContext> = {
    notify: (text) => notices.push(text),
    custom: async (factory) => {
      const script = dialogs.shift();
      if (script === undefined) throw new Error("No scripted Secret Request dialog");
      return new Promise((resolve) => {
        void (async () => {
          const component: Component = await factory(
            // SAFETY: the dialog only asks the TUI to re-render.
            { requestRender: () => {} } as never,
            // SAFETY: the dialog styles only through `fg`, `bg`, and `bold`.
            taggedTheme as never,
            // SAFETY: the dialog matches keys through the keybindings manager only.
            getKeybindings() as never,
            resolve,
          );
          frames.push(component.render(80));
          for (const key of script) {
            component.handleInput?.(key);
            frames.push(component.render(80));
          }
        })();
      });
    },
  };
  /**
   * The value a codemode script receives from one `secret_*` call, checked against the tool's
   * declared `outputSchema`.
   */
  const value = (toolCallId: string) => {
    const recorded = values.get(toolCallId);
    if (recorded === undefined) throw new Error(`No secret_* result for ${toolCallId}`);
    const schema = session.getToolDefinition(recorded.tool)?.outputSchema;
    if (schema === undefined) throw new Error(`${recorded.tool} declares no outputSchema`);
    expect(
      [...Value.Errors(schema, recorded.structuredContent)].map((error) => error.message),
      `${recorded.tool} structuredContent violates its outputSchema`,
    ).toEqual([]);
    return recorded.structuredContent;
  };
  // Every successful `secret_*` result in every test must match its declared schema.
  onTestFinished(() => {
    for (const [toolCallId, recorded] of values) if (!recorded.isError) value(toolCallId);
  });

  const runner = session.extensionRunner;
  if (!runner) throw new Error("Missing extension runner");
  await session.bindExtensions(
    options.headless
      ? { mode: "print" }
      : { mode: "tui", uiContext: { ...runner.getUIContext(), ...ui } },
  );

  /** The session file's full text, as written to disk. */
  const sessionFileText = async () => {
    const path = session.sessionManager.getSessionFile();
    if (path === undefined) throw new Error("The session has no file");
    return readFile(path, "utf8");
  };
  /** Text of the tool result for one call, as the transcript holds it. */
  const resultText = (toolCallId: string) => {
    for (const message of session.messages)
      if (message.role === "toolResult" && message.toolCallId === toolCallId)
        return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
    return undefined;
  };
  /** One transcript tool result message. */
  const result = (toolCallId: string) =>
    session.messages.find(
      (message) => message.role === "toolResult" && message.toolCallId === toolCallId,
    );
  /** End the session as quitting Pi does: extensions get `session_shutdown`, then it is disposed. */
  const quit = async () => {
    await runner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  };
  return {
    dir,
    clock,
    quit,
    session,
    responses,
    requests,
    requestMessages,
    received,
    frames,
    notices,
    sessionFileText,
    resultText,
    result,
    value,
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
