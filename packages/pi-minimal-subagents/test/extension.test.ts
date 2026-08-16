import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import {
  DefaultResourceLoader,
  ExtensionRunner,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  type AgentSettledEvent,
  type MessageEndEvent,
  type SessionBeforeForkEvent,
  type SessionShutdownEvent,
  type SessionStartEvent,
  type SessionTreeEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
  RuntimeCreationRequest,
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
  readonly sessionFile: string;
  readonly sessionId: string;
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
    this.sessionFile = `/recording-sessions/${agentId}.jsonl`;
    this.sessionId = `session-${agentId}`;
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

  dispose(): void {
    this.disposed = true;
  }

  getRuntimeProfile(): RuntimeProfile {
    return { model: "lifecycle-test/model", thinking_level: "medium" };
  }

  snapshotCommittedMessages(): AgentMessage[] {
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
  readonly restoredAgentIds: string[] = [];
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

  async createRuntime(request: RuntimeCreationRequest): Promise<ChildAgentRuntime> {
    const runtime = this.runtimeFor(request.agent.agent_id);
    return runtime;
  }

  async restoreRuntime(agent: PersistedAgent): Promise<ChildAgentRuntime> {
    this.restoredAgentIds.push(agent.agent_id);
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
  sentMessageTypes: string[];
  notifications: RecordedNotification[];
  extensionErrors: string[];
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
  const notifications: RecordedNotification[] = [];
  const extensionErrors: string[] = [];
  runner.onError((error) => extensionErrors.push(error.error));
  let activeTools = ["read"];
  runner.bindCore(
    {
      sendMessage: (message) => sentMessageTypes.push(message.customType),
      sendUserMessage: () => undefined,
      appendEntry: (customType, data) => sessionManager.appendCustomEntry(customType, data),
      setSessionName: (name) => sessionManager.appendSessionInfo(name),
      getSessionName: () => sessionManager.getSessionName(),
      setLabel: (entryId, label) => sessionManager.appendLabelChange(entryId, label),
      getActiveTools: () => [...activeTools],
      getAllTools: () => [
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
    sentMessageTypes,
    notifications,
    extensionErrors,
    setIdle(nextIdle) {
      idle = nextIdle;
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
    expect(harness.runner.hasHandlers("agent_settled")).toBe(true);
    expect(harness.runner.hasHandlers("session_shutdown")).toBe(true);

    await harness.runner.emit(sessionStartEvent());
    expect(harness.runner.getAllRegisteredTools().map((tool) => tool.definition.name)).toEqual([
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
    expect(harness.sessionFactory.restoredAgentIds).toEqual(["branch-a"]);

    sessionManager.branch(branchPoint);
    appendRegistryCheckpoint(sessionManager, sessionManager.getSessionId(), {
      agents: [persistedAgent("branch-b")],
      tombstones: [],
      deliveries: [],
    });
    await harness.runner.emit(sessionTreeEvent);
    expect(harness.sessionFactory.restoredAgentIds).toEqual(["branch-a", "branch-b"]);

    await emitSessionShutdown(harness, "quit");
  });

  it("does not release root delivery on a stale settled event and does not redeliver after reconciliation", async () => {
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

    await harness.runner.emit(agentSettledEvent);
    expect(harness.sentMessageTypes).toEqual([]);

    harness.setIdle(true);
    await harness.runner.emit(agentSettledEvent);
    await vi.waitFor(
      () => {
        expect(harness.sentMessageTypes).toEqual(["minimal-subagents.result"]);
      },
      { timeout: 2_000 },
    );
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
    expect(harness.sessionFactory.restoredAgentIds).toEqual(["selected-child"]);
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

  it("surfaces runtime construction failure before registering coordinator tools", async () => {
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
    expect(harness.runner.getAllRegisteredTools()).toEqual([]);
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
