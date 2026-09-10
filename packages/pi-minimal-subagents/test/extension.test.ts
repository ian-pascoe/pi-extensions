import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  CustomEditor,
  DefaultResourceLoader,
  ExtensionRunner,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSettledEvent,
  type ExtensionUIContext,
  type KeybindingsManager,
  type MessageEndEvent,
  type SessionBeforeForkEvent,
  type SessionShutdownEvent,
  type SessionStartEvent,
  type SessionTreeEvent,
  type Theme,
  type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import {
  ProcessTerminal,
  TuiMainScreen,
  type TUI,
  type Component,
  type EditorComponent,
  type EditorTheme,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { COORDINATOR_TOOL_NAMES } from "../src/minimal-subagents-capabilities.js";
import {
  createMinimalSubagentsExtension,
  type MinimalSubagentsLifecycleEffects,
} from "../src/minimal-subagents-extension.js";
import {
  REGISTRY_ENTRY_TYPE,
  createRegistryEvent,
  replayRegistryEntries,
} from "../src/minimal-subagents-registry.js";
import type { PiAgentSessionFactoryOptions } from "../src/minimal-subagents-sessions.js";
import {
  isForkDestinationForSource,
  rememberForkSnapshot,
  takeForkSnapshot,
} from "../src/minimal-subagents-fork-lifecycle.js";
import type {
  AgentSessionFactory,
  ChildAgentRuntime,
  PersistedAgent,
  PersistedSessionIdentity,
  RegistrySnapshot,
  RuntimeProfile,
  RuntimeTurnOutcome,
} from "../src/minimal-subagents-types.js";

const temporaryDirectories: string[] = [];
const TEST_MODEL: Model<"openai-completions"> = {
  id: "model",
  name: "Lifecycle test model",
  api: "openai-completions",
  provider: "lifecycle-test",
  baseUrl: "http://127.0.0.1:1/v1",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
};

class RecordingChildRuntime implements ChildAgentRuntime {
  readonly sessionLeafId: string;
  isRunning = false;
  abortCount = 0;
  disposed = false;
  private promptOutcome: PromiseWithResolvers<RuntimeTurnOutcome> | undefined;

  constructor(
    agentId: string,
    private readonly holdPrompt: boolean,
    private readonly abortGate: Promise<void> | undefined,
  ) {
    this.sessionLeafId = `leaf-${agentId}`;
  }

  async runPrompt(): Promise<RuntimeTurnOutcome> {
    if (!this.holdPrompt) {
      return { status: "completed", output: "completed child turn" };
    }
    this.isRunning = true;
    this.promptOutcome = Promise.withResolvers<RuntimeTurnOutcome>();
    return this.promptOutcome.promise;
  }

  async runMessage(): Promise<RuntimeTurnOutcome> {
    return { status: "completed", output: "completed child message" };
  }

  async queueCoordinatorMessage(): Promise<void> {}

  async abort(): Promise<void> {
    this.abortCount++;
    await this.abortGate;
    this.isRunning = false;
    this.promptOutcome?.resolve({ status: "cancelled", output: "" });
  }

  completePrompt(): void {
    this.isRunning = false;
    this.promptOutcome?.resolve({ status: "completed", output: "completed after disable" });
  }

  dispose(): void {
    this.disposed = true;
  }

  getRuntimeProfile(): RuntimeProfile {
    return { model: "lifecycle-test/model", thinking_level: "medium" };
  }

  snapshotCommittedMessages(): AgentMessage[] {
    return [];
  }

  snapshotActivityMessages(): AgentMessage[] {
    return [];
  }

  hasDeliveryEvidence(): boolean {
    return false;
  }

  getUsage(): undefined {
    return undefined;
  }
}

class RecordingAgentSessionFactory implements AgentSessionFactory {
  readonly createdAgentIds: string[] = [];
  readonly openedAgentIds: string[] = [];
  readonly clonedAgentIds: string[] = [];
  readonly adoptedAgentIds: string[] = [];
  readonly trashedAgentIds: string[] = [];
  readonly runtimes = new Map<string, RecordingChildRuntime>();
  holdPrompts = false;
  abortGate: Promise<void> | undefined;

  createIdentity(agent: PersistedAgent): PersistedSessionIdentity {
    this.createdAgentIds.push(agent.agent_id);
    return {
      sessionFile: `/recording-sessions/${agent.agent_id}.jsonl`,
      sessionId: `session-${agent.agent_id}`,
      sessionLeafId: `leaf-${agent.agent_id}`,
    };
  }

  async openRuntime(agent: PersistedAgent): Promise<ChildAgentRuntime> {
    this.openedAgentIds.push(agent.agent_id);
    return this.runtimeFor(agent.agent_id);
  }

  async resolveLaunchMissingDependencies(): Promise<string[]> {
    return [];
  }

  async resolveRestorationMissingDependencies(): Promise<string[]> {
    return [];
  }

  resolveThinkingLevel(_modelId: string, requested: ThinkingLevel): ThinkingLevel {
    return requested;
  }

  modelSupportsImages(): boolean {
    return true;
  }

  async cloneSession(agent: PersistedAgent): Promise<PersistedSessionIdentity> {
    this.clonedAgentIds.push(agent.agent_id);
    return this.clonedIdentity(agent.agent_id);
  }

  async cloneForkSourceSession(agent: PersistedAgent): Promise<PersistedSessionIdentity> {
    this.clonedAgentIds.push(agent.agent_id);
    return this.clonedIdentity(agent.agent_id);
  }

  async adoptForkSessionOwnership(agent: PersistedAgent): Promise<PersistedSessionIdentity> {
    this.adoptedAgentIds.push(agent.agent_id);
    return {
      sessionFile: agent.session_file ?? `/recording-sessions/${agent.agent_id}.jsonl`,
      sessionId: agent.session_id ?? `session-${agent.agent_id}`,
      sessionLeafId: agent.session_leaf_id ?? `leaf-${agent.agent_id}`,
    };
  }

  async trashSession(agent: PersistedAgent): Promise<void> {
    this.trashedAgentIds.push(agent.agent_id);
  }

  private runtimeFor(agentId: string): RecordingChildRuntime {
    const existing = this.runtimes.get(agentId);
    if (existing) return existing;
    const runtime = new RecordingChildRuntime(agentId, this.holdPrompts, this.abortGate);
    this.runtimes.set(agentId, runtime);
    return runtime;
  }

  private clonedIdentity(agentId: string): PersistedSessionIdentity {
    return {
      sessionFile: `/recording-clones/${agentId}.jsonl`,
      sessionId: `clone-${agentId}`,
      sessionLeafId: `clone-leaf-${agentId}`,
    };
  }
}

type RecordedNotification = {
  message: string;
  level: "info" | "warning" | "error";
};

type ExtensionHarness = {
  runner: ExtensionRunner;
  sessionManager: SessionManager;
  sessionFactory: RecordingAgentSessionFactory;
  agentDirectory: string;
  sentMessageTypes: string[];
  sentDeliveryModes: Array<"steer" | "followUp" | "nextTurn" | undefined>;
  notifications: RecordedNotification[];
  extensionErrors: string[];
  getActiveTools(): string[];
  setActiveTools(toolNames: string[]): void;
  setIdle(idle: boolean): void;
};

let modelRegistry: ModelRegistry;
let modelRuntimeDirectory: string;

beforeAll(async () => {
  modelRuntimeDirectory = await createTemporaryDirectory("minimal-subagents-model-runtime-");
  const runtime = await ModelRuntime.create({
    authPath: join(modelRuntimeDirectory, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRegistry = new ModelRegistry(runtime);
  modelRegistry.registerProvider("lifecycle-test", {
    name: "Lifecycle test provider",
    baseUrl: TEST_MODEL.baseUrl,
    apiKey: "test-key",
    api: TEST_MODEL.api,
    models: [TEST_MODEL],
  });
});

afterEach(() => {
  globalThis.minimalSubagentsForkSnapshots = undefined;
  vi.restoreAllMocks();
});

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function createTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function appendUserMessage(sessionManager: SessionManager, text: string): string {
  return sessionManager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
}

function requireSessionFile(sessionManager: SessionManager): string {
  const sessionFile = sessionManager.getSessionFile();
  if (!sessionFile) throw new Error("Expected a persisted lifecycle test session");
  return sessionFile;
}

function persistedAgent(agentId: string): PersistedAgent {
  return {
    agent_id: agentId,
    friendly_id: agentId,
    parent_id: "root",
    created_at: "2026-08-15T00:00:00.000Z",
    spawn_entry_id: `spawn-${agentId}`,
    session_file: `/source-sessions/${agentId}.jsonl`,
    session_id: `source-session-${agentId}`,
    session_leaf_id: `source-leaf-${agentId}`,
    launch_contract: {
      session_context: "inherit",
      project_context: "inherit",
      model: "lifecycle-test/model",
      thinking_level: "medium",
      tools: "read",
      ordinary_tools: ["read"],
      delegation: "fanout",
    },
    capability_ceiling: ["read"],
    availability: "available",
    missing_dependencies: [],
    recent_messages: [],
  };
}

function appendRegistryCheckpoint(
  sessionManager: SessionManager,
  rootSessionId: string,
  snapshot: RegistrySnapshot,
): string {
  return sessionManager.appendCustomEntry(
    REGISTRY_ENTRY_TYPE,
    createRegistryEvent(rootSessionId, "checkpoint", { snapshot }),
  );
}

async function createPersistedSession(
  cwd: string,
  sessionDirectory: string,
  options?: { parentSession?: string },
): Promise<SessionManager> {
  const sessionManager = SessionManager.create(cwd, sessionDirectory, options);
  appendUserMessage(sessionManager, "root lifecycle prompt");
  sessionManager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "root lifecycle answer" }],
    api: TEST_MODEL.api,
    provider: TEST_MODEL.provider,
    model: TEST_MODEL.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  return sessionManager;
}

async function createExtensionHarness(
  sessionManager: SessionManager,
  sessionFactory = new RecordingAgentSessionFactory(),
  createSessionFactory?: (options: PiAgentSessionFactoryOptions) => AgentSessionFactory,
  rootTools?: ToolInfo[],
): Promise<ExtensionHarness> {
  const cwd = sessionManager.getCwd();
  const agentDirectory = await createTemporaryDirectory("minimal-subagents-lifecycle-agent-");
  const effects: MinimalSubagentsLifecycleEffects = {
    getAgentDirectory: () => agentDirectory,
    createSessionFactory: createSessionFactory ?? (() => sessionFactory),
  };
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: agentDirectory,
    extensionFactories: [
      {
        name: "minimal-subagents-lifecycle-test",
        factory: createMinimalSubagentsExtension(effects),
      },
    ],
    noContextFiles: true,
    noPromptTemplates: true,
    noSkills: true,
    noThemes: true,
  });
  await resourceLoader.reload();
  const extensions = resourceLoader.getExtensions();
  expect(extensions.errors).toEqual([]);
  expect(extensions.extensions).toHaveLength(1);

  const runner = new ExtensionRunner(
    extensions.extensions,
    extensions.runtime,
    cwd,
    sessionManager,
    modelRegistry,
  );
  let idle = true;
  const sentMessageTypes: string[] = [];
  const sentDeliveryModes: Array<"steer" | "followUp" | "nextTurn" | undefined> = [];
  const notifications: RecordedNotification[] = [];
  const extensionErrors: string[] = [];
  runner.onError((error) => extensionErrors.push(error.error));
  let activeTools = ["read"];
  runner.bindCore(
    {
      sendMessage: (message, options) => {
        sentMessageTypes.push(message.customType);
        sentDeliveryModes.push(options?.deliverAs);
      },
      sendUserMessage: () => undefined,
      appendEntry: (customType, data) => sessionManager.appendCustomEntry(customType, data),
      setSessionName: (name) => sessionManager.appendSessionInfo(name),
      getSessionName: () => sessionManager.getSessionName(),
      setLabel: (entryId, label) => sessionManager.appendLabelChange(entryId, label),
      getActiveTools: () => [...activeTools],
      getAllTools: () =>
        rootTools ?? [
          {
            name: "read",
            description: "Read a file",
            parameters: Type.Object({}),
            sourceInfo: {
              path: "<builtin:read>",
              source: "builtin",
              scope: "temporary",
              origin: "top-level",
            },
          },
        ],
      setActiveTools: (toolNames) => {
        activeTools = [...toolNames];
      },
      refreshTools: () => undefined,
      getCommands: () => [],
      setModel: async () => true,
      getThinkingLevel: () => "medium",
      setThinkingLevel: () => undefined,
    },
    {
      getModel: () => TEST_MODEL,
      getScopedModels: () => [],
      isIdle: () => idle,
      isProjectTrusted: () => true,
      getSignal: () => undefined,
      abort: () => undefined,
      hasPendingMessages: () => false,
      shutdown: () => undefined,
      getContextUsage: () => undefined,
      compact: () => undefined,
      getSystemPrompt: () => "Lifecycle test system prompt",
    },
  );
  runner.bindCommandContext({
    waitForIdle: async () => {
      while (!idle) await new Promise((resolve) => setTimeout(resolve, 1));
    },
    newSession: async () => ({ cancelled: false }),
    fork: async () => ({ cancelled: false }),
    navigateTree: async () => ({ cancelled: false }),
    switchSession: async () => ({ cancelled: false }),
    reload: async () => undefined,
  });
  const defaultUi = runner.getUIContext();
  runner.setUIContext(
    {
      ...defaultUi,
      notify: (message, level) => notifications.push({ message, level: level ?? "info" }),
    },
    "rpc",
  );
  return {
    runner,
    sessionManager,
    sessionFactory,
    agentDirectory,
    sentMessageTypes,
    sentDeliveryModes,
    notifications,
    extensionErrors,
    getActiveTools: () => [...activeTools],
    setActiveTools: (toolNames) => {
      activeTools = [...toolNames];
    },
    setIdle(nextIdle) {
      idle = nextIdle;
    },
  };
}

type EditorFactory = NonNullable<ReturnType<ExtensionUIContext["getEditorComponent"]>>;

async function createShortcutHarness(previousFactory?: EditorFactory) {
  const cwd = await createTemporaryDirectory("minimal-subagents-shortcut-");
  const sessionManager = await createPersistedSession(cwd, cwd);
  const harness = await createExtensionHarness(sessionManager);
  const tui = new TuiMainScreen(new ProcessTerminal());
  vi.spyOn(tui, "requestRender").mockImplementation(() => {});
  const editorTheme: EditorTheme = {
    borderColor: (text) => text,
    selectList: {
      selectedPrefix: (text) => text,
      selectedText: (text) => text,
      description: (text) => text,
      scrollInfo: (text) => text,
      noMatch: (text) => text,
    },
  };
  const bindings: Pick<KeybindingsManager, "matches"> = { matches: () => false };
  let currentFactory = previousFactory;
  let editor: EditorComponent | undefined;
  const custom = vi.fn();
  const setEditorComponent: ExtensionUIContext["setEditorComponent"] = (factory) => {
    currentFactory = factory;
    // SAFETY: This editor test exercises no application keybindings beyond the checked matches method.
    editor = factory?.(tui, editorTheme, bindings as KeybindingsManager);
    tui.setFocus(editor ?? null);
  };
  harness.runner.setUIContext(
    {
      ...harness.runner.getUIContext(),
      custom: <T>() => {
        custom();
        return new Promise<T>(() => {});
      },
      getEditorComponent: () => currentFactory,
      setEditorComponent,
    },
    "tui",
  );
  await harness.runner.emit(sessionStartEvent());
  return {
    ...harness,
    tui,
    custom,
    setEditorComponent,
    getFactory: () => currentFactory,
    editor: () => {
      if (!editor) throw new Error("Expected the installed main editor");
      return editor;
    },
  };
}

function sessionStartEvent(
  reason: SessionStartEvent["reason"] = "startup",
  previousSessionFile?: string,
): SessionStartEvent {
  const event: SessionStartEvent = { type: "session_start", reason };
  if (previousSessionFile !== undefined) event.previousSessionFile = previousSessionFile;
  return event;
}

const sessionTreeEvent = {
  type: "session_tree",
  newLeafId: null,
  oldLeafId: null,
} satisfies SessionTreeEvent;
const agentSettledEvent = { type: "agent_settled" } satisfies AgentSettledEvent;
const toolResultMessageEndEvent = {
  type: "message_end",
  message: {
    role: "toolResult",
    toolCallId: "wait-call",
    toolName: "subagent_wait",
    content: [{ type: "text", text: "delivery evidence" }],
    isError: false,
    timestamp: 1,
  },
} satisfies MessageEndEvent;

async function emitSessionShutdown(
  harness: ExtensionHarness,
  reason: SessionShutdownEvent["reason"],
): Promise<void> {
  await harness.runner.emit({ type: "session_shutdown", reason } satisfies SessionShutdownEvent);
}

describe("minimal subagents extension lifecycle", () => {
  it("registers both renderers and all six real coordinator tools, then hands off only a confirmed fork", async () => {
    const cwd = await createTemporaryDirectory("minimal-subagents-lifecycle-cwd-");
    const sessionDirectory = await createTemporaryDirectory(
      "minimal-subagents-lifecycle-sessions-",
    );
    const sessionManager = await createPersistedSession(cwd, sessionDirectory);
    const selectedEntryId = sessionManager.getLeafId();
    if (!selectedEntryId) throw new Error("Expected a selected fork entry");
    const harness = await createExtensionHarness(sessionManager);

    expect(harness.runner.getMessageRenderer("minimal-subagents.message")).toBeDefined();
    expect(harness.runner.getMessageRenderer("minimal-subagents.result")).toBeDefined();
    expect(harness.runner.hasHandlers("session_start")).toBe(true);
    expect(harness.runner.hasHandlers("session_before_fork")).toBe(true);
    expect(harness.runner.hasHandlers("session_tree")).toBe(true);
    expect(harness.runner.hasHandlers("message_end")).toBe(true);
    expect(harness.runner.hasHandlers("agent_settled")).toBe(false);
    expect(harness.runner.hasHandlers("session_shutdown")).toBe(true);
    expect(harness.runner.getCommand("subagents")?.description).toBe(
      "Control Subagent Access and inspect Child Agents",
    );

    await harness.runner.emit(sessionStartEvent());
    expect(harness.runner.getAllRegisteredTools().map((tool) => tool.definition.name)).toEqual([
      "subagent",
      "agent_message",
      "subagent_wait",
      "subagent_status",
      "subagent_cancel",
      "subagent_delete",
    ]);
    expect(harness.getActiveTools()).toEqual([
      "read",
      "subagent",
      "agent_message",
      "subagent_wait",
      "subagent_status",
      "subagent_cancel",
      "subagent_delete",
    ]);

    await harness.runner.emit({
      type: "session_before_fork",
      entryId: selectedEntryId,
      position: "at",
    } satisfies SessionBeforeForkEvent);
    const sourceSessionFile = requireSessionFile(sessionManager);
    expect(takeForkSnapshot(sourceSessionFile)).toBeUndefined();

    await emitSessionShutdown(harness, "fork");
    expect(takeForkSnapshot(sourceSessionFile)).toMatchObject({
      source_root_session_file: sourceSessionFile,
      source_root_session_id: sessionManager.getSessionId(),
    });
  });

  it("restores coordinator tool rendering before reload session startup", async () => {
    const cwd = await createTemporaryDirectory("minimal-subagents-render-reload-cwd-");
    const sessionDirectory = await createTemporaryDirectory(
      "minimal-subagents-render-reload-sessions-",
    );
    const agentDirectory = await createTemporaryDirectory("minimal-subagents-render-reload-agent-");
    const sessionManager = await createPersistedSession(cwd, sessionDirectory);
    const settingsManager = SettingsManager.create(cwd, agentDirectory, {
      projectTrusted: true,
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir: agentDirectory,
      settingsManager,
      extensionFactories: [
        {
          name: "minimal-subagents-render-reload-test",
          factory: createMinimalSubagentsExtension({
            getAgentDirectory: () => agentDirectory,
            createSessionFactory: () => new RecordingAgentSessionFactory(),
          }),
        },
      ],
      noContextFiles: true,
      noPromptTemplates: true,
      noSkills: true,
      noThemes: true,
    });
    await resourceLoader.reload();
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDirectory, "auth.json"),
      modelsPath: null,
      refreshOnCreate: false,
    });
    const { session } = await createAgentSession({
      cwd,
      agentDir: agentDirectory,
      model: TEST_MODEL,
      modelRuntime,
      resourceLoader,
      sessionManager,
      settingsManager,
    });
    try {
      await session.bindExtensions({
        mode: "rpc",
        uiContext: session.extensionRunner.getUIContext(),
      });
      let renderedToolNamesBeforeSessionStart: string[] = [];
      await session.reload({
        beforeSessionStart: () => {
          renderedToolNamesBeforeSessionStart = COORDINATOR_TOOL_NAMES.filter((toolName) => {
            const definition = session.getToolDefinition(toolName);
            return definition?.renderCall !== undefined && definition.renderResult !== undefined;
          });
        },
      });

      expect(renderedToolNamesBeforeSessionStart).toEqual(COORDINATOR_TOOL_NAMES);
    } finally {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
  });

  it("identifies pi-codex-conversion as a Child Agent runtime tool adapter", async () => {
    const cwd = await createTemporaryDirectory("minimal-subagents-tool-provider-cwd-");
    const sessionDirectory = await createTemporaryDirectory(
      "minimal-subagents-tool-provider-sessions-",
    );
    const sessionManager = await createPersistedSession(cwd, sessionDirectory);
    const sessionFactory = new RecordingAgentSessionFactory();
    const adapterEntrypoint = join(cwd, "codex-tool-adapter.js");
    const prefixCollisionEntrypoint = join(cwd, "codex-tool-adapter-collision.js");
    let capturedOptions: PiAgentSessionFactoryOptions | undefined;
    const harness = await createExtensionHarness(
      sessionManager,
      sessionFactory,
      (options) => {
        capturedOptions = options;
        return sessionFactory;
      },
      [
        {
          name: "exec_command",
          description: "Run a command",
          parameters: Type.Object({}),
          sourceInfo: {
            path: adapterEntrypoint,
            source: "npm:@howaboua/pi-codex-conversion@3.0.23",
            scope: "user",
            origin: "package",
          },
        },
        {
          name: "write_stdin",
          description: "Write to a running command",
          parameters: Type.Object({}),
          sourceInfo: {
            path: adapterEntrypoint,
            source: "npm:@howaboua/pi-codex-conversion@3.0.23",
            scope: "user",
            origin: "package",
          },
        },
        {
          name: "apply_patch",
          description: "Patch files",
          parameters: Type.Object({}),
          sourceInfo: {
            path: adapterEntrypoint,
            source: "npm:@howaboua/pi-codex-conversion@3.0.23",
            scope: "user",
            origin: "package",
          },
        },
        {
          name: "prefix_collision",
          description: "Unrelated package tool",
          parameters: Type.Object({}),
          sourceInfo: {
            path: prefixCollisionEntrypoint,
            source: "npm:@howaboua/pi-codex-conversion-other",
            scope: "user",
            origin: "package",
          },
        },
      ],
    );
    harness.setActiveTools(["exec_command", "write_stdin"]);

    await harness.runner.emit(sessionStartEvent());

    expect(capturedOptions?.getRuntimeToolAdapters?.()).toEqual([
      {
        toolNames: ["exec_command", "write_stdin", "apply_patch"],
        replacements: [
          {
            sourceToolNames: ["read", "grep", "find", "ls"],
            runtimeToolNames: ["exec_command", "write_stdin"],
          },
          {
            sourceToolNames: ["bash"],
            runtimeToolNames: ["exec_command", "write_stdin"],
          },
          {
            sourceToolNames: ["edit", "write"],
            runtimeToolNames: ["apply_patch"],
          },
        ],
      },
    ]);
    await emitSessionShutdown(harness, "quit");
  });

  it("changes branch and scoped Subagent Access through the registered command", async () => {
    const cwd = await createTemporaryDirectory("minimal-subagents-command-cwd-");
    const sessionDirectory = await createTemporaryDirectory("minimal-subagents-command-sessions-");
    const sessionManager = await createPersistedSession(cwd, sessionDirectory);
    const harness = await createExtensionHarness(sessionManager);
    await harness.runner.emit(sessionStartEvent());
    const command = harness.runner.getCommand("subagents");
    if (!command) throw new Error("Expected the registered /subagents command");
    const context = harness.runner.createCommandContext();

    await command.handler("disable", context);
    expect(harness.getActiveTools()).toEqual(["read"]);

    await command.handler("enable", context);
    expect(harness.getActiveTools()).toContain("subagent");

    await command.handler("disable --global", context);
    expect(harness.getActiveTools()).toEqual(["read"]);
    expect(
      JSON.parse(await readFile(join(harness.agentDirectory, "settings.json"), "utf8")),
    ).toMatchObject({ minimalSubagents: { enabled: false } });

    await command.handler("reset", context);
    expect(harness.getActiveTools()).toEqual(["read"]);

    await command.handler("enable --project", context);
    expect(harness.getActiveTools()).toContain("subagent");
    expect(JSON.parse(await readFile(join(cwd, ".pi", "settings.json"), "utf8"))).toMatchObject({
      minimalSubagents: { enabled: true },
    });

    harness.setActiveTools(["read", "subagent"]);
    await command.handler("", context);
    expect(harness.getActiveTools()).toEqual(["read", "subagent"]);
    expect(harness.notifications.at(-1)?.message).toContain("Coordinator Tools 1/6");

    const activeBeforeInvalid = harness.getActiveTools();
    await command.handler("status --global", context);
    expect(harness.getActiveTools()).toEqual(activeBeforeInvalid);
    expect(harness.notifications.at(-1)?.message).toContain("Usage: /subagents");

    await emitSessionShutdown(harness, "quit");
  });

  it("opens and closes the live status view through the registered bare command", async () => {
    const cwd = await createTemporaryDirectory("minimal-subagents-status-command-cwd-");
    const sessionDirectory = await createTemporaryDirectory(
      "minimal-subagents-status-command-sessions-",
    );
    const sessionManager = await createPersistedSession(cwd, sessionDirectory);
    const harness = await createExtensionHarness(sessionManager);
    await harness.runner.emit(sessionStartEvent());
    const command = harness.runner.getCommand("subagents");
    if (!command) throw new Error("Expected the registered /subagents command");

    const tui = {
      terminal: { rows: 20, columns: 100 } satisfies Pick<TUI["terminal"], "rows" | "columns">,
      requestRender: vi.fn<TUI["requestRender"]>(),
    };
    const theme = {
      fg: (_color, text) => text,
      bg: (_color, text) => text,
      bold: (text) => text,
    } satisfies Pick<Theme, "fg" | "bg" | "bold">;
    const keybindings: Pick<KeybindingsManager, "matches" | "getKeys"> = {
      matches: (data, binding) => data === "escape" && binding === "tui.select.cancel",
      getKeys: () => ["ctrl+o"],
    };
    let rendered: string[] = [];
    let customOptions: Parameters<ExtensionUIContext["custom"]>[1];
    const custom: ExtensionUIContext["custom"] = async <T>(
      factory: (
        tui: TUI,
        theme: Theme,
        keybindings: KeybindingsManager,
        done: (result: T) => void,
      ) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
      options?: Parameters<ExtensionUIContext["custom"]>[1],
    ): Promise<T> => {
      customOptions = options;
      const result = Promise.withResolvers<T>();
      const component = await factory(
        // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: The status view reads only checked terminal dimensions and the typed requestRender mock.
        tui as unknown as TUI,
        // SAFETY: The framed status render reads only the checked fg, bg, and bold methods.
        theme as Theme,
        // SAFETY: This command test sends only Escape and renders hints through the checked methods.
        keybindings as KeybindingsManager,
        result.resolve,
      );
      rendered = component.render(80);
      component.handleInput?.("escape");
      return result.promise;
    };
    harness.runner.setUIContext({ ...harness.runner.getUIContext(), custom }, "tui");

    await command.handler("", harness.runner.createCommandContext());

    expect(customOptions).toMatchObject({ overlay: true });
    expect(rendered.join("\n")).toContain("Subagents status");
    expect(rendered.join("\n")).toContain("Access: enabled");
    await emitSessionShutdown(harness, "quit");
  });

  it("opens the same viewer on double Left in the empty editor while the root is working", async () => {
    const harness = await createShortcutHarness();
    const clock = vi.spyOn(performance, "now").mockReturnValue(1000);
    try {
      harness.setIdle(false);
      harness.editor().handleInput("\x1b[D");
      expect(harness.custom).not.toHaveBeenCalled();
      harness.editor().handleInput("\x1b[1;1:3D"); // Kitty Left release is not another press.
      clock.mockReturnValue(1500);
      harness.editor().handleInput("\x1b[D");
      expect(harness.custom).toHaveBeenCalledOnce();
      const command = harness.runner.getCommand("subagents");
      if (!command) throw new Error("Expected /subagents");
      void command.handler("", harness.runner.createCommandContext());
      expect(harness.custom).toHaveBeenCalledOnce();
      expect(harness.editor().getText()).toBe("");
    } finally {
      clock.mockRestore();
      harness.setIdle(true);
      await emitSessionShutdown(harness, "quit");
    }
  });

  it.each([
    { text: "", keys: ["\x1b[D", "\x1b[D"], gap: 501 },
    { text: " ", keys: ["\x1b[D", "\x1b[D"], gap: 50 },
    { text: "draft", keys: ["\x1b[D", "\x1b[D"], gap: 50 },
    { text: "", keys: ["\x1b[D", "\x1b[C", "\x1b[D"], gap: 50 },
    { text: "", keys: ["\x1b[D", "\x1b[1;1:2D"], gap: 50 },
  ])("preserves ordinary editing for $text / $keys at $gap ms", async ({ text, keys, gap }) => {
    const harness = await createShortcutHarness();
    const clock = vi.spyOn(performance, "now");
    try {
      harness.editor().setText(text);
      for (const [index, key] of keys.entries()) {
        clock.mockReturnValue(1000 + index * gap);
        harness.editor().handleInput(key);
      }
      expect(harness.custom).not.toHaveBeenCalled();
      expect(harness.editor().getText()).toBe(text);
    } finally {
      await emitSessionShutdown(harness, "quit");
    }
  });

  it("resets double Left when the main editor loses focus or changes session branch", async () => {
    const harness = await createShortcutHarness();
    vi.spyOn(performance, "now").mockReturnValue(1000);
    try {
      const editor = harness.editor();
      editor.handleInput("\x1b[D");
      const dialog = { render: () => [], invalidate() {}, handleInput: vi.fn() };
      harness.tui.setFocus(dialog);
      dialog.handleInput("\x1b[D");
      dialog.handleInput("\x1b[D");
      expect(harness.custom).not.toHaveBeenCalled();
      harness.tui.setFocus(editor);
      editor.handleInput("\x1b[D");
      expect(harness.custom).not.toHaveBeenCalled();
      await harness.runner.emit(sessionTreeEvent);
      editor.handleInput("\x1b[D");
      expect(harness.custom).not.toHaveBeenCalled();
      editor.handleInput("\x1b[D");
      expect(harness.custom).toHaveBeenCalledOnce();
    } finally {
      await emitSessionShutdown(harness, "quit");
    }
  });

  it("preserves a previous editor's methods and restores its factory on shutdown", async () => {
    class ExistingEditor extends CustomEditor {
      #received: string[] = [];
      override handleInput(data: string): void {
        this.#received.push(data);
        super.handleInput(data);
      }
      received(): string[] {
        return this.#received;
      }
    }
    let existing: ExistingEditor | undefined;
    const previous: EditorFactory = (...args) => {
      existing = new ExistingEditor(...args);
      return existing;
    };
    const harness = await createShortcutHarness(previous);
    try {
      harness.editor().setText("draft");
      harness.editor().handleInput("\x1b[D");
      harness.editor().handleInput("\x1b[D");
      expect(existing?.received()).toEqual(["\x1b[D", "\x1b[D"]);
      expect(existing?.getCursor()).toMatchObject({ col: 3 });
      expect(harness.custom).not.toHaveBeenCalled();
      // SAFETY: The installed proxy retains the previous editor's complete public interface.
      expect((harness.editor() as ExistingEditor).received()).toEqual(["\x1b[D", "\x1b[D"]);
    } finally {
      await emitSessionShutdown(harness, "quit");
    }
    expect(harness.getFactory()).toBe(previous);
  });

  it("installs a fresh shortcut after reload without carrying the previous Left press", async () => {
    const harness = await createShortcutHarness();
    vi.spyOn(performance, "now").mockReturnValue(1000);
    harness.editor().handleInput("\x1b[D");
    await emitSessionShutdown(harness, "reload");
    expect(harness.getFactory()).toBeUndefined();
    await harness.runner.emit(sessionStartEvent("reload"));
    try {
      harness.editor().handleInput("\x1b[D");
      expect(harness.custom).not.toHaveBeenCalled();
      harness.editor().handleInput("\x1b[D");
      expect(harness.custom).toHaveBeenCalledOnce();
      expect(harness.extensionErrors).toEqual([]);
    } finally {
      await emitSessionShutdown(harness, "quit");
    }
  });

  it("does not remove a later editor replacement and disables retained wrappers on shutdown", async () => {
    const harness = await createShortcutHarness();
    const retained = harness.getFactory();
    if (!retained) throw new Error("Expected the shortcut factory");
    const later: EditorFactory = (...args) => retained(...args);
    harness.setEditorComponent(later);
    const editor = harness.editor();
    await emitSessionShutdown(harness, "quit");
    expect(harness.getFactory()).toBe(later);
    editor.handleInput("\x1b[D");
    editor.handleInput("\x1b[D");
    expect(harness.custom).not.toHaveBeenCalled();
  });

  it("restores the selected branch's Subagent Access without changing Child Agents", async () => {
    const cwd = await createTemporaryDirectory("minimal-subagents-access-tree-cwd-");
    const sessionDirectory = await createTemporaryDirectory(
      "minimal-subagents-access-tree-sessions-",
    );
    const sessionManager = await createPersistedSession(cwd, sessionDirectory);
    const branchPoint = sessionManager.getLeafId();
    if (!branchPoint) throw new Error("Expected a Subagent Access branch point");
    const harness = await createExtensionHarness(sessionManager);
    await harness.runner.emit(sessionStartEvent());
    const command = harness.runner.getCommand("subagents");
    if (!command) throw new Error("Expected the registered /subagents command");

    await command.handler("disable", harness.runner.createCommandContext());
    const disabledLeaf = sessionManager.getLeafId();
    if (!disabledLeaf) throw new Error("Expected a disabled Subagent Access leaf");
    expect(harness.getActiveTools()).toEqual(["read"]);

    sessionManager.branch(branchPoint);
    await harness.runner.emit(sessionTreeEvent);
    expect(harness.getActiveTools()).toContain("subagent");

    const active = [...harness.getActiveTools(), "mcp_late"];
    harness.setActiveTools(active);
    sessionManager.branch(branchPoint);
    await harness.runner.emit(sessionTreeEvent);
    expect(harness.getActiveTools()).toEqual(active);

    sessionManager.branch(disabledLeaf);
    await harness.runner.emit(sessionTreeEvent);
    expect(harness.getActiveTools()).toEqual(["read", "mcp_late"]);

    await emitSessionShutdown(harness, "quit");

    const reloadedHarness = await createExtensionHarness(sessionManager);
    await reloadedHarness.runner.emit(sessionStartEvent("reload"));
    expect(reloadedHarness.getActiveTools()).toEqual(["read"]);
    await emitSessionShutdown(reloadedHarness, "quit");
  });

  it("starts from trusted project, global, then built-in Subagent Access settings", async () => {
    const cwd = await createTemporaryDirectory("minimal-subagents-access-settings-cwd-");
    const sessionDirectory = await createTemporaryDirectory(
      "minimal-subagents-access-settings-sessions-",
    );
    const sessionManager = await createPersistedSession(cwd, sessionDirectory);
    const harness = await createExtensionHarness(sessionManager);
    await mkdir(harness.agentDirectory, { recursive: true });
    await writeFile(
      join(harness.agentDirectory, "settings.json"),
      JSON.stringify({ minimalSubagents: { enabled: false } }),
    );
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({ minimalSubagents: { enabled: true } }),
    );

    await harness.runner.emit(sessionStartEvent());
    expect(harness.getActiveTools()).toContain("subagent");
    await emitSessionShutdown(harness, "quit");
  });

  it("preserves tool order on redundant enable/reset and keeps Child Agents running across access changes", async () => {
    const cwd = await createTemporaryDirectory("minimal-subagents-disable-running-cwd-");
    const sessionDirectory = await createTemporaryDirectory(
      "minimal-subagents-disable-running-sessions-",
    );
    const sessionManager = await createPersistedSession(cwd, sessionDirectory);
    const sessionFactory = new RecordingAgentSessionFactory();
    sessionFactory.holdPrompts = true;
    const harness = await createExtensionHarness(sessionManager, sessionFactory);
    await harness.runner.emit(sessionStartEvent());

    const spawnTool = harness.runner.getToolDefinition("subagent");
    if (!spawnTool) throw new Error("Expected the registered subagent tool");
    await spawnTool.execute(
      "running-spawn",
      { task: "Continue after disable", agent_id: "running-child", delegation: "fanout" },
      undefined,
      undefined,
      harness.runner.createContext(),
    );
    await vi.waitFor(() => {
      expect(sessionFactory.runtimes.get("running-child")?.isRunning).toBe(true);
    });

    const command = harness.runner.getCommand("subagents");
    if (!command) throw new Error("Expected the registered /subagents command");
    const active = [...harness.getActiveTools(), "mcp_late"];
    harness.setActiveTools(active);
    for (const action of ["enable", "enable", "reset"]) {
      await command.handler(action, harness.runner.createCommandContext());
      expect(harness.getActiveTools()).toEqual(active);
      expect(sessionFactory.runtimes.get("running-child")).toMatchObject({
        isRunning: true,
        abortCount: 0,
      });
    }
    await command.handler("disable", harness.runner.createCommandContext());
    expect(harness.getActiveTools()).toEqual(["read", "mcp_late"]);
    expect(sessionFactory.runtimes.get("running-child")).toMatchObject({
      isRunning: true,
      abortCount: 0,
    });

    sessionFactory.runtimes.get("running-child")?.completePrompt();
    await vi.waitFor(
      () => {
        expect(harness.sentMessageTypes).toEqual(["minimal-subagents.result"]);
      },
      { timeout: 2_000 },
    );

    await emitSessionShutdown(harness, "quit");
  });

  it("leaves current Subagent Access unchanged when a scoped settings write fails", async () => {
    const cwd = await createTemporaryDirectory("minimal-subagents-settings-failure-cwd-");
    const sessionDirectory = await createTemporaryDirectory(
      "minimal-subagents-settings-failure-sessions-",
    );
    const sessionManager = await createPersistedSession(cwd, sessionDirectory);
    const harness = await createExtensionHarness(sessionManager);
    await harness.runner.emit(sessionStartEvent());
    await mkdir(harness.agentDirectory, { recursive: true });
    const globalSettingsPath = join(harness.agentDirectory, "settings.json");
    await writeFile(globalSettingsPath, "{ malformed");
    const activeBefore = harness.getActiveTools();
    const command = harness.runner.getCommand("subagents");
    if (!command) throw new Error("Expected the registered /subagents command");

    await command.handler("disable --global", harness.runner.createCommandContext());

    expect(harness.getActiveTools()).toEqual(activeBefore);
    await expect(readFile(globalSettingsPath, "utf8")).resolves.toBe("{ malformed");
    expect(harness.notifications.at(-1)?.message).toContain("settings JSON is malformed");
    await emitSessionShutdown(harness, "quit");
  });

  it("restores only the active Registry branch and restores the newly selected tree branch", async () => {
    const cwd = await createTemporaryDirectory("minimal-subagents-tree-cwd-");
    const sessionDirectory = await createTemporaryDirectory("minimal-subagents-tree-sessions-");
    const sessionManager = await createPersistedSession(cwd, sessionDirectory);
    const branchPoint = sessionManager.getLeafId();
    if (!branchPoint) throw new Error("Expected a tree branch point");
    appendRegistryCheckpoint(sessionManager, sessionManager.getSessionId(), {
      agents: [persistedAgent("branch-a")],
      tombstones: [],
      deliveries: [],
    });
    const harness = await createExtensionHarness(sessionManager);

    await harness.runner.emit(sessionStartEvent());
    expect(harness.sessionFactory.openedAgentIds).toEqual(["branch-a"]);

    sessionManager.branch(branchPoint);
    appendRegistryCheckpoint(sessionManager, sessionManager.getSessionId(), {
      agents: [persistedAgent("branch-b")],
      tombstones: [],
      deliveries: [],
    });
    await harness.runner.emit(sessionTreeEvent);
    expect(harness.sessionFactory.openedAgentIds).toEqual(["branch-a", "branch-b"]);

    await emitSessionShutdown(harness, "quit");
  });

  it("steers a completed result into an active root turn without duplicate reconciliation", async () => {
    const cwd = await createTemporaryDirectory("minimal-subagents-delivery-cwd-");
    const sessionDirectory = await createTemporaryDirectory("minimal-subagents-delivery-sessions-");
    const sessionManager = await createPersistedSession(cwd, sessionDirectory);
    const harness = await createExtensionHarness(sessionManager);
    await harness.runner.emit(sessionStartEvent());
    harness.setIdle(false);

    const spawnTool = harness.runner.getToolDefinition("subagent");
    if (!spawnTool) throw new Error("Expected the registered subagent tool");
    await spawnTool.execute(
      "spawn-call",
      { task: "Complete a lifecycle delivery", agent_id: "delivery-child" },
      undefined,
      undefined,
      harness.runner.createContext(),
    );
    await vi.waitFor(() => {
      expect(harness.sessionFactory.createdAgentIds).toEqual(["delivery-child"]);
    });

    await vi.waitFor(
      () => {
        expect(harness.sentMessageTypes).toEqual(["minimal-subagents.result"]);
      },
      { timeout: 2_000 },
    );
    expect(harness.sentDeliveryModes).toEqual(["steer"]);
    await harness.runner.emit(agentSettledEvent);
    await harness.runner.emitMessageEnd(toolResultMessageEndEvent);
    await harness.runner.emitMessageEnd(toolResultMessageEndEvent);
    expect(harness.sentMessageTypes).toEqual(["minimal-subagents.result"]);

    await emitSessionShutdown(harness, "quit");
  });

  it("consumes a stored fork handoff without cloning the source root", async () => {
    const cwd = await createTemporaryDirectory("minimal-subagents-stored-fork-cwd-");
    const sessionDirectory = await createTemporaryDirectory(
      "minimal-subagents-stored-fork-sessions-",
    );
    const source = await createPersistedSession(cwd, sessionDirectory);
    const sourceSessionFile = requireSessionFile(source);
    const sourceRootSessionId = SessionManager.open(sourceSessionFile).getSessionId();
    const destination = await createPersistedSession(cwd, sessionDirectory, {
      parentSession: sourceSessionFile,
    });
    rememberForkSnapshot({
      source_root_session_file: sourceSessionFile,
      source_root_session_id: sourceRootSessionId,
      agents: [],
      tombstones: ["stored-fork"],
      deliveries: [],
    });
    expect(globalThis.minimalSubagentsForkSnapshots?.size).toBe(1);
    expect(isForkDestinationForSource(destination.getHeader(), sourceSessionFile)).toBe(true);
    expect(SessionManager.open(sourceSessionFile).getSessionId()).toBe(sourceRootSessionId);
    const harness = await createExtensionHarness(destination);

    await harness.runner.emit(sessionStartEvent("fork", sourceSessionFile));
    expect(harness.extensionErrors).toEqual([]);
    expect(harness.sessionFactory.clonedAgentIds).toEqual([]);
    expect(harness.sessionFactory.adoptedAgentIds).toEqual([]);
    expect(takeForkSnapshot(sourceSessionFile)).toBeUndefined();
    expect(
      replayRegistryEntries(destination.getBranch(), destination.getSessionId()).tombstones,
    ).toContain("stored-fork");

    await emitSessionShutdown(harness, "quit");
  });

  it("recovers from process loss using the copied destination branch rather than a newer source head", async () => {
    const cwd = await createTemporaryDirectory("minimal-subagents-process-loss-cwd-");
    const sessionDirectory = await createTemporaryDirectory(
      "minimal-subagents-process-loss-sessions-",
    );
    const source = await createPersistedSession(cwd, sessionDirectory);
    const selectedSnapshot: RegistrySnapshot = {
      agents: [persistedAgent("selected-child")],
      tombstones: ["selected-branch"],
      deliveries: [],
    };
    const sourceSessionFile = requireSessionFile(source);
    const sourceRootSessionId = SessionManager.open(sourceSessionFile).getSessionId();
    appendRegistryCheckpoint(source, sourceRootSessionId, selectedSnapshot);
    const destination = await createPersistedSession(cwd, sessionDirectory, {
      parentSession: sourceSessionFile,
    });
    appendRegistryCheckpoint(destination, sourceRootSessionId, selectedSnapshot);
    expect(isForkDestinationForSource(destination.getHeader(), sourceSessionFile)).toBe(true);
    expect(
      replayRegistryEntries(destination.getBranch(), sourceRootSessionId).agents.map(
        (agent) => agent.agent_id,
      ),
    ).toEqual(["selected-child"]);
    appendRegistryCheckpoint(source, sourceRootSessionId, {
      agents: [persistedAgent("newer-source-head")],
      tombstones: ["newer-source-head"],
      deliveries: [],
    });
    const harness = await createExtensionHarness(destination);

    await harness.runner.emit(sessionStartEvent("fork", sourceSessionFile));
    expect(harness.extensionErrors).toEqual([]);
    expect(harness.sessionFactory.clonedAgentIds).toEqual(["selected-child"]);
    expect(harness.sessionFactory.adoptedAgentIds).toEqual(["selected-child"]);
    expect(harness.sessionFactory.openedAgentIds).toEqual(["selected-child"]);
    expect(harness.sessionFactory.clonedAgentIds).not.toContain("newer-source-head");
    expect(
      replayRegistryEntries(destination.getBranch(), destination.getSessionId()).tombstones,
    ).toContain("selected-branch");

    await emitSessionShutdown(harness, "quit");
  });

  it("rejects process-loss recovery when destination provenance does not match the source", async () => {
    const cwd = await createTemporaryDirectory("minimal-subagents-provenance-cwd-");
    const sessionDirectory = await createTemporaryDirectory(
      "minimal-subagents-provenance-sessions-",
    );
    const source = await createPersistedSession(cwd, sessionDirectory);
    const sourceSessionFile = requireSessionFile(source);
    const destination = await createPersistedSession(cwd, sessionDirectory, {
      parentSession: join(sessionDirectory, "unrelated.jsonl"),
    });
    const harness = await createExtensionHarness(destination);

    await harness.runner.emit(sessionStartEvent("fork", sourceSessionFile));
    expect(harness.sessionFactory.clonedAgentIds).toEqual([]);
    expect(harness.sessionFactory.adoptedAgentIds).toEqual([]);
    expect(harness.notifications).toContainEqual({
      message:
        "Minimal subagents fork recovery skipped because the destination selected branch could not be proven from parentSession provenance.",
      level: "warning",
    });
    expect(
      replayRegistryEntries(destination.getBranch(), destination.getSessionId()).agents,
    ).toEqual([]);

    await emitSessionShutdown(harness, "quit");
  });

  it("surfaces runtime construction failure while retaining inert coordinator tools", async () => {
    const cwd = await createTemporaryDirectory("minimal-subagents-construction-cwd-");
    const sessionDirectory = await createTemporaryDirectory(
      "minimal-subagents-construction-sessions-",
    );
    const sessionManager = await createPersistedSession(cwd, sessionDirectory);
    const harness = await createExtensionHarness(
      sessionManager,
      new RecordingAgentSessionFactory(),
      () => {
        throw new Error("session runtime construction failed");
      },
    );

    await harness.runner.emit(sessionStartEvent());
    expect(harness.extensionErrors).toContain("session runtime construction failed");
    expect(harness.runner.getAllRegisteredTools().map((tool) => tool.definition.name)).toEqual(
      COORDINATOR_TOOL_NAMES,
    );
  });

  it("awaits active child cancellation before completing session shutdown", async () => {
    const cwd = await createTemporaryDirectory("minimal-subagents-shutdown-cwd-");
    const sessionDirectory = await createTemporaryDirectory("minimal-subagents-shutdown-sessions-");
    const sessionManager = await createPersistedSession(cwd, sessionDirectory);
    const sessionFactory = new RecordingAgentSessionFactory();
    sessionFactory.holdPrompts = true;
    const abortGate = Promise.withResolvers<void>();
    sessionFactory.abortGate = abortGate.promise;
    const harness = await createExtensionHarness(sessionManager, sessionFactory);
    await harness.runner.emit(sessionStartEvent());

    const spawnTool = harness.runner.getToolDefinition("subagent");
    if (!spawnTool) throw new Error("Expected the registered subagent tool");
    await spawnTool.execute(
      "shutdown-spawn",
      { task: "Remain active through shutdown", agent_id: "active-child" },
      undefined,
      undefined,
      harness.runner.createContext(),
    );
    await vi.waitFor(() => {
      expect(sessionFactory.runtimes.get("active-child")?.isRunning).toBe(true);
    });

    let shutdownCompleted = false;
    const shutdown = emitSessionShutdown(harness, "quit").then(() => {
      shutdownCompleted = true;
    });
    await Promise.resolve();
    expect(shutdownCompleted).toBe(false);
    expect(sessionFactory.runtimes.get("active-child")?.abortCount).toBe(1);

    abortGate.resolve();
    await shutdown;
    expect(shutdownCompleted).toBe(true);
    expect(sessionFactory.runtimes.get("active-child")?.disposed).toBe(true);
  });
});
