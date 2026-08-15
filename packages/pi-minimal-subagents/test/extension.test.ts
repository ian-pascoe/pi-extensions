import { beforeEach, describe, expect, it, vi } from "vitest";

const testDoubles = vi.hoisted(() => ({
  coordinatorInstances: [] as Array<Record<string, ReturnType<typeof vi.fn>>>,
  coordinatorRestore: vi.fn<(snapshot: unknown) => Promise<void>>(async () => undefined),
  takeForkSnapshot: vi.fn(),
  rememberForkSnapshot: vi.fn(),
  replayRegistryEntries: vi.fn(
    (): {
      agents: unknown[];
      tombstones: string[];
      deliveries: unknown[];
    } => ({ agents: [], tombstones: [], deliveries: [] }),
  ),
  sessionManagerOpen: vi.fn(),
  shutdownSession: vi.fn(async () => undefined),
  uiInstances: [] as Array<{
    refresh: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
  buildSessionContext: vi.fn(() => ({ messages: [] })),
  getAgentDir: vi.fn(() => "/agent"),
  SessionManager: { open: testDoubles.sessionManagerOpen },
  SettingsManager: {
    create: vi.fn(() => ({
      getEnabledModels: () => undefined,
      getGlobalSettings: () => ({}),
      getProjectSettings: () => ({}),
    })),
  },
}));

vi.mock("../src/minimal-subagents-coordinator.js", () => ({
  MinimalSubagentsCoordinator: class {
    restore = vi.fn((snapshot: unknown) => testDoubles.coordinatorRestore(snapshot));
    writeCheckpoint = vi.fn();
    inspectStatus = vi.fn(() => ({ root_id: "root", agents: [] }));
    canAgentSpawn = vi.fn(() => true);
    snapshotChildCaller = vi.fn();
    prepareFork = vi.fn(async (sourceRootSessionFile: string) => ({
      source_root_session_file: sourceRootSessionFile,
      agents: [],
      tombstones: ["forked"],
      deliveries: [],
    }));
    scheduleDeliveryReconciliation = vi.fn();
    reconcileDeliveries = vi.fn(async () => undefined);
    markRecipientIdle = vi.fn();
    waitForSettledOperations = vi.fn(async () => undefined);
    shutdownAfterSettling = vi.fn(async () => undefined);
    shutdown = vi.fn(async () => undefined);

    constructor() {
      testDoubles.coordinatorInstances.push(this as never);
    }
  },
}));

vi.mock("../src/minimal-subagents-config.js", () => ({
  resolveMinimalSubagentsSettings: vi.fn(() => ({
    maxSubagentDepth: 2,
    modelRoles: [],
    warnings: [],
  })),
}));

vi.mock("../src/minimal-subagents-fork-lifecycle.js", () => ({
  rememberForkSnapshot: testDoubles.rememberForkSnapshot,
  takeForkSnapshot: testDoubles.takeForkSnapshot,
}));

vi.mock("../src/minimal-subagents-registry.js", () => ({
  CHILD_IDENTITY_ENTRY_TYPE: "minimal-subagents.identity",
  REGISTRY_ENTRY_TYPE: "minimal-subagents.registry",
  replayRegistryEntries: testDoubles.replayRegistryEntries,
}));

vi.mock("../src/minimal-subagents-sessions.js", () => ({
  findDeliveryEvidence: vi.fn(() => false),
  PiAgentSessionFactory: class {},
}));

vi.mock("../src/minimal-subagents-shutdown.js", () => ({
  shutdownMinimalSubagentsSession: testDoubles.shutdownSession,
}));

vi.mock("../src/minimal-subagents-tools.js", () => ({
  createCoordinatorToolDefinitions: vi.fn(() =>
    [
      "subagent",
      "agent_message",
      "subagent_wait",
      "subagent_status",
      "subagent_cancel",
      "subagent_delete",
    ].map((name) => ({ name })),
  ),
}));

vi.mock("../src/minimal-subagents-rendering.js", () => ({
  renderMinimalSubagentsMessage: vi.fn(),
  renderMinimalSubagentsResult: vi.fn(),
}));

vi.mock("../src/minimal-subagents-ui.js", () => ({
  MinimalSubagentsUiController: class {
    refresh = vi.fn();
    dispose = vi.fn();
    constructor() {
      testDoubles.uiInstances.push(this);
    }
  },
}));

import minimalSubagentsExtension from "../src/index.js";

function extensionFixture() {
  const handlers = new Map<string, (...arguments_: any[]) => Promise<void> | void>();
  const renderers: string[] = [];
  const registeredTools: string[] = [];
  const pi = {
    registerMessageRenderer: (name: string) => renderers.push(name),
    on: (name: string, handler: (...arguments_: any[]) => Promise<void> | void) =>
      handlers.set(name, handler),
    getAllTools: () => [{ name: "read" }],
    getActiveTools: () => ["read"],
    getThinkingLevel: () => "medium",
    registerTool: ({ name }: { name: string }) => registeredTools.push(name),
    setActiveTools: vi.fn(),
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  };
  const sessionManager = {
    getSessionId: () => "root-session",
    getSessionDir: () => "/sessions",
    getEntries: () => [],
    getLeafId: () => "root-leaf",
    getSessionFile: () => "/sessions/root.jsonl",
  };
  const context = {
    cwd: "/project",
    mode: "rpc",
    model: { provider: "provider", id: "model" },
    thinkingLevel: "medium",
    scopedModels: [],
    modelRegistry: { getAvailable: () => [{ provider: "provider", id: "model" }] },
    sessionManager,
    isProjectTrusted: () => true,
    isIdle: () => true,
    ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() },
  };
  minimalSubagentsExtension(pi as never);
  return { context, handlers, pi, registeredTools, renderers };
}

beforeEach(() => {
  testDoubles.coordinatorInstances.length = 0;
  testDoubles.coordinatorRestore.mockReset().mockResolvedValue(undefined);
  testDoubles.uiInstances.length = 0;
  testDoubles.takeForkSnapshot.mockReset();
  testDoubles.rememberForkSnapshot.mockReset();
  testDoubles.replayRegistryEntries.mockReset().mockReturnValue({
    agents: [],
    tombstones: [],
    deliveries: [],
  });
  testDoubles.shutdownSession.mockClear();
  testDoubles.sessionManagerOpen.mockReset();
});

describe("minimal subagents extension lifecycle", () => {
  it("registers both renderers, all six root tools, and awaits lifecycle reconciliation and shutdown", async () => {
    const { context, handlers, registeredTools, renderers } = extensionFixture();
    expect(renderers).toEqual(["minimal-subagents.message", "minimal-subagents.result"]);
    expect([...handlers.keys()]).toEqual([
      "session_start",
      "session_before_fork",
      "message_end",
      "agent_settled",
      "session_shutdown",
    ]);
    await handlers.get("session_start")!({ reason: "startup" }, context);
    expect(registeredTools).toEqual([
      "subagent",
      "agent_message",
      "subagent_wait",
      "subagent_status",
      "subagent_cancel",
      "subagent_delete",
    ]);
    const coordinator = testDoubles.coordinatorInstances[0]!;
    await handlers.get("session_before_fork")!({}, context);
    expect(testDoubles.rememberForkSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ source_root_session_file: "/sessions/root.jsonl" }),
    );
    await handlers.get("message_end")!({ message: { role: "toolResult" } });
    await handlers.get("message_end")!({ message: { role: "custom" } });
    await handlers.get("message_end")!({ message: { role: "user" } });
    expect(coordinator.reconcileDeliveries).toHaveBeenCalledTimes(2);
    await handlers.get("agent_settled")!({});
    expect(coordinator.markRecipientIdle).toHaveBeenCalledWith("root");
    await handlers.get("session_shutdown")!({ reason: "exit" }, context);
    expect(testDoubles.shutdownSession).toHaveBeenCalledOnce();
    expect(testDoubles.uiInstances[0]!.dispose).toHaveBeenCalledOnce();
  });

  it("awaits and surfaces session restoration failures before registering tools", async () => {
    testDoubles.coordinatorRestore.mockRejectedValueOnce(new Error("registry restore failed"));
    const { context, handlers, registeredTools } = extensionFixture();
    await expect(handlers.get("session_start")!({ reason: "startup" }, context)).rejects.toThrow(
      "registry restore failed",
    );
    expect(registeredTools).toEqual([]);
    expect(testDoubles.uiInstances).toEqual([]);
  });

  it("consumes a stored fork snapshot without replaying or cloning the old root", async () => {
    const stored = {
      source_root_session_file: "/sessions/old.jsonl",
      agents: [],
      tombstones: ["stored"],
      deliveries: [],
    };
    testDoubles.takeForkSnapshot.mockReturnValue(stored);
    const { context, handlers } = extensionFixture();
    await handlers.get("session_start")!(
      { reason: "fork", previousSessionFile: "/sessions/old.jsonl" },
      context,
    );
    const coordinator = testDoubles.coordinatorInstances[0]!;
    expect(coordinator.restore).toHaveBeenCalledWith(stored);
    expect(coordinator.prepareFork).not.toHaveBeenCalled();
    expect(testDoubles.sessionManagerOpen).not.toHaveBeenCalled();
  });

  it("replays and clones the previous root when no stored fork snapshot exists", async () => {
    const replayed = { agents: [], tombstones: ["replayed"], deliveries: [] };
    testDoubles.replayRegistryEntries.mockReturnValue(replayed);
    testDoubles.sessionManagerOpen.mockReturnValue({
      getSessionId: () => "old-root",
      getEntries: () => [{ type: "custom" }],
    });
    const { context, handlers } = extensionFixture();
    await handlers.get("session_start")!(
      { reason: "fork", previousSessionFile: "/sessions/old.jsonl" },
      context,
    );
    const coordinator = testDoubles.coordinatorInstances[0]!;
    expect(coordinator.restore).toHaveBeenNthCalledWith(1, replayed);
    expect(coordinator.prepareFork).toHaveBeenCalledWith("/sessions/old.jsonl");
    expect(coordinator.restore).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ tombstones: ["forked"] }),
    );
  });
});
