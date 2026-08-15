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
  cloneForkSourceSession: vi.fn(
    async (agent: { agent_id?: string; session_file?: string; session_id?: string }) => ({
      sessionFile: agent.session_file,
      sessionId: agent.session_id,
      sessionLeafId: `leaf-${agent.agent_id ?? "agent"}`,
    }),
  ),
  adoptForkSessionOwnership: vi.fn(
    async (agent: { session_file?: string; session_id?: string; session_leaf_id?: string }) => ({
      sessionFile: agent.session_file,
      sessionId: agent.session_id,
      sessionLeafId: agent.session_leaf_id ?? "owned-leaf",
    }),
  ),
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
      source_root_session_id: "root-session",
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
  isForkDestinationForSource: vi.fn(
    (header: { parentSession?: string }, source: string) => header.parentSession === source,
  ),
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
  PiAgentSessionFactory: class {
    cloneForkSourceSession = testDoubles.cloneForkSourceSession;
    adoptForkSessionOwnership = testDoubles.adoptForkSessionOwnership;
  },
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
  const branchEntries: unknown[] = [];
  const sessionManager = {
    getSessionId: () => "root-session",
    getSessionDir: () => "/sessions",
    getHeader: vi.fn(() => ({ parentSession: "/sessions/old.jsonl" })),
    getEntries: () => [{ type: "custom", customType: "abandoned-branch" }],
    getBranch: () => branchEntries,
    getEntry: (entryId: string) => ({ id: entryId, parentId: "selected-parent" }),
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
    isIdle: vi.fn(() => true),
    ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() },
  };
  minimalSubagentsExtension(pi as never);
  return { branchEntries, context, handlers, pi, registeredTools, renderers };
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
  testDoubles.cloneForkSourceSession.mockClear();
  testDoubles.adoptForkSessionOwnership.mockClear();
  testDoubles.sessionManagerOpen.mockReset().mockReturnValue({
    getSessionId: () => "old-root",
    getBranch: () => [],
  });
});

describe("minimal subagents extension lifecycle", () => {
  it("registers both renderers, all six root tools, and awaits lifecycle reconciliation and shutdown", async () => {
    const { context, handlers, registeredTools, renderers } = extensionFixture();
    expect(renderers).toEqual(["minimal-subagents.message", "minimal-subagents.result"]);
    expect([...handlers.keys()]).toEqual([
      "session_start",
      "session_before_fork",
      "session_tree",
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
    await handlers.get("session_before_fork")!(
      { entryId: "selected-entry", position: "before" },
      context,
    );
    expect(testDoubles.rememberForkSnapshot).not.toHaveBeenCalled();
    expect(coordinator.prepareFork).not.toHaveBeenCalled();
    await handlers.get("message_end")!({ message: { role: "toolResult" } });
    await handlers.get("message_end")!({ message: { role: "custom" } });
    await handlers.get("message_end")!({ message: { role: "user" } });
    expect(coordinator.reconcileDeliveries).toHaveBeenCalledTimes(2);
    await handlers.get("agent_settled")!({}, context);
    expect(coordinator.markRecipientIdle).toHaveBeenCalledWith("root");
    await handlers.get("session_shutdown")!({ reason: "fork" }, context);
    expect(testDoubles.rememberForkSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ source_root_session_file: "/sessions/root.jsonl" }),
    );
    expect(testDoubles.shutdownSession).toHaveBeenCalledOnce();
    expect(testDoubles.uiInstances[0]!.dispose).toHaveBeenCalledOnce();
  });

  it("replays only the active branch and restores again after tree navigation", async () => {
    const { branchEntries, context, handlers } = extensionFixture();
    branchEntries.push({ type: "custom", customType: "active-branch" });
    await handlers.get("session_start")!({ reason: "startup" }, context);
    expect(testDoubles.replayRegistryEntries).toHaveBeenCalledWith(
      branchEntries,
      "root-session",
      expect.any(Function),
    );

    branchEntries.push({ type: "custom", customType: "new-tree-leaf" });
    await handlers.get("session_tree")!({}, context);
    const coordinator = testDoubles.coordinatorInstances[0]!;
    expect(coordinator.restore).toHaveBeenCalledTimes(2);
    expect(coordinator.writeCheckpoint).toHaveBeenCalledTimes(2);
  });

  it("does not release delivery latches for a stale settled event", async () => {
    const { context, handlers } = extensionFixture();
    await handlers.get("session_start")!({ reason: "startup" }, context);
    context.isIdle.mockReturnValue(false);
    await handlers.get("agent_settled")!({}, context);
    expect(testDoubles.coordinatorInstances[0]!.markRecipientIdle).not.toHaveBeenCalled();
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
      source_root_session_id: "old-root",
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
    expect(testDoubles.sessionManagerOpen).toHaveBeenCalledWith("/sessions/old.jsonl");
  });

  it("replays the proven destination branch and clones its recorded child positions after process loss", async () => {
    const replayed = { agents: [], tombstones: ["replayed"], deliveries: [] };
    testDoubles.replayRegistryEntries.mockReturnValue(replayed);
    const readSourceHead = vi.fn(() => [{ type: "custom", customType: "unselected-source-head" }]);
    testDoubles.sessionManagerOpen.mockReturnValue({
      getSessionId: () => "old-root",
      getBranch: readSourceHead,
    });
    const { context, handlers } = extensionFixture();
    await handlers.get("session_start")!(
      { reason: "fork", previousSessionFile: "/sessions/old.jsonl" },
      context,
    );
    const coordinator = testDoubles.coordinatorInstances[0]!;
    expect(testDoubles.replayRegistryEntries).toHaveBeenCalledWith(
      context.sessionManager.getBranch(),
      "old-root",
      expect.any(Function),
    );
    expect(coordinator.prepareFork).not.toHaveBeenCalled();
    expect(readSourceHead).not.toHaveBeenCalled();
    expect(coordinator.restore).toHaveBeenCalledOnce();
    expect(coordinator.restore).toHaveBeenCalledWith(
      expect.objectContaining({
        tombstones: ["replayed"],
        source_root_session_id: "old-root",
      }),
    );
  });

  it("fails safe without replaying the source head when fork branch provenance is unprovable", async () => {
    const { context, handlers } = extensionFixture();
    context.sessionManager.getHeader.mockReturnValue({
      parentSession: "/sessions/unrelated.jsonl",
    });

    await handlers.get("session_start")!(
      { reason: "fork", previousSessionFile: "/sessions/old.jsonl" },
      context,
    );

    const coordinator = testDoubles.coordinatorInstances[0]!;
    expect(testDoubles.replayRegistryEntries).not.toHaveBeenCalled();
    expect(coordinator.prepareFork).not.toHaveBeenCalled();
    expect(coordinator.restore).toHaveBeenCalledWith({
      agents: [],
      tombstones: [],
      deliveries: [],
    });
    expect(context.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("selected branch could not be proven"),
      "warning",
    );
  });
});
