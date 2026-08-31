import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import { MinimalSubagentsCoordinator } from "../src/minimal-subagents-coordinator.js";
import type { RegistryEventV2 } from "../src/minimal-subagents-registry.js";
import type {
  AgentSessionFactory,
  CallerSnapshot,
  ChildAgentRuntime,
  ChildAgentTranscriptSnapshot,
  CoordinatorDependencies,
  CoordinatorMessage,
  PersistedAgent,
  RootConversationEndpoint,
  RuntimeProfile,
  RuntimeTurnOutcome,
} from "../src/minimal-subagents-types.js";

function persistedAgent(
  agentId: string,
  parentId: string,
  delegation: "none" | "fanout" = "fanout",
): PersistedAgent {
  return {
    agent_id: agentId,
    friendly_id: agentId.split(".").at(-1)!,
    parent_id: parentId,
    created_at: "2026-01-01T00:00:00.000Z",
    spawn_entry_id: "entry",
    session_file: `/sessions/${agentId}.jsonl`,
    session_id: `session-${agentId}`,
    session_leaf_id: `leaf-${agentId}`,
    launch_contract: {
      session_context: "inherit",
      project_context: "inherit",
      model: "provider/model",
      thinking_level: "medium",
      tools: "read",
      ordinary_tools: ["read"],
      delegation,
    },
    capability_ceiling: ["read"],
    availability: "available",
    missing_dependencies: [],
    recent_messages: [],
  };
}

function childRuntime(
  outcome: RuntimeTurnOutcome = { status: "completed", output: "done" },
  runtimeProfile: RuntimeProfile | undefined = {
    model: "provider/model",
    thinking_level: "medium",
  },
) {
  return {
    sessionLeafId: "runtime-leaf",
    isRunning: false,
    runPrompt: vi.fn(async () => outcome),
    runMessage: vi.fn(async () => outcome),
    queueCoordinatorMessage: vi.fn<(message: CoordinatorMessage) => Promise<void>>(
      async () => undefined,
    ),
    abort: vi.fn<() => Promise<void>>(async () => undefined),
    dispose: vi.fn(),
    getRuntimeProfile: vi.fn<() => RuntimeProfile | undefined>(() => runtimeProfile),
    snapshotCommittedMessages: vi.fn<() => AgentMessage[]>(() => []),
    snapshotActivityMessages: vi.fn<() => AgentMessage[]>(() => []),
    snapshotActivityTranscript: vi.fn<() => ChildAgentTranscriptSnapshot>(() => ({
      messages: [],
      toolDefinitions: [],
    })),
    hasDeliveryEvidence: vi.fn<
      (sourceAgentId: string, sourceTurnId: string, deliveryId?: string) => boolean
    >(() => false),
    getUsage: vi.fn(() => undefined),
  } satisfies ChildAgentRuntime;
}

function coordinatorFixture(runtime = childRuntime(), automaticDeliveryGraceMs = 0) {
  const registryEvents: RegistryEventV2[] = [];
  const sessions = {
    createIdentity: vi.fn<AgentSessionFactory["createIdentity"]>((agent) => ({
      sessionFile: `/sessions/${agent.agent_id}.jsonl`,
      sessionId: `session-${agent.agent_id}`,
      sessionLeafId: `leaf-${agent.agent_id}`,
    })),
    openRuntime: vi.fn<(agent: PersistedAgent) => Promise<ChildAgentRuntime>>(async () => runtime),
    resolveLaunchMissingDependencies: vi.fn<(agent: PersistedAgent) => Promise<string[]>>(
      async () => [],
    ),
    resolveRestorationMissingDependencies: vi.fn<(agent: PersistedAgent) => Promise<string[]>>(
      async () => [],
    ),
    resolveThinkingLevel: vi.fn(
      (_model: string, thinking: CallerSnapshot["thinkingLevel"]) => thinking,
    ),
    modelSupportsImages: vi.fn(() => true),
    cloneSession: vi.fn(async (agent: PersistedAgent) => ({
      sessionFile: `/fork/${agent.agent_id}.jsonl`,
      sessionId: `fork-${agent.agent_id}`,
      sessionLeafId: `fork-leaf-${agent.agent_id}`,
    })),
    cloneForkSourceSession: vi.fn(async (agent: PersistedAgent) => ({
      sessionFile: `/fork/${agent.agent_id}.jsonl`,
      sessionId: `fork-${agent.agent_id}`,
      sessionLeafId: `fork-leaf-${agent.agent_id}`,
    })),
    adoptForkSessionOwnership: vi.fn(async (agent: PersistedAgent) => ({
      sessionFile: `/fork/${agent.agent_id}.jsonl`,
      sessionId: `fork-${agent.agent_id}`,
      sessionLeafId: `fork-leaf-${agent.agent_id}`,
    })),
    trashSession: vi.fn<(agent: PersistedAgent) => Promise<void>>(async () => undefined),
  } satisfies AgentSessionFactory;
  const queuedMessages: CoordinatorMessage[] = [];
  let rootIdle = true;
  const root = {
    queueCoordinatorMessage: vi.fn(async (message: CoordinatorMessage): Promise<void> => {
      queuedMessages.push(message);
    }),
    isIdle: vi.fn(() => rootIdle),
    hasDeliveryEvidence: vi.fn<
      (sourceAgentId: string, sourceTurnId: string, deliveryId?: string) => boolean
    >(() => false),
  } satisfies RootConversationEndpoint;
  const notify = vi.fn();
  const dependencies = {
    registry: {
      rootSessionId: "root-session",
      append: (event: RegistryEventV2) => registryEvents.push(event),
    },
    sessions,
    root,
    notify,
    maxSubagentDepth: 2,
    automaticDeliveryGraceMs,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  } satisfies CoordinatorDependencies;
  return {
    coordinator: new MinimalSubagentsCoordinator(dependencies),
    notify,
    root,
    sessions,
    registryEvents,
    queuedMessages,
    setRootIdle: (idle: boolean) => (rootIdle = idle),
  };
}

const caller: CallerSnapshot = {
  messages: [],
  model: "provider/model",
  thinkingLevel: "medium",
  ordinaryTools: ["read"],
  capabilityCeiling: ["read"],
  spawnEntryId: "entry",
};

describe("minimal subagents coordinator", () => {
  it("persists child identity before runtime creation and leaves no agent when identity creation fails", async () => {
    const order: string[] = [];
    const { coordinator, sessions } = coordinatorFixture();
    sessions.createIdentity.mockImplementation((agent: PersistedAgent) => {
      order.push("identity");
      return {
        sessionFile: `/sessions/${agent.agent_id}.jsonl`,
        sessionId: `session-${agent.agent_id}`,
        sessionLeafId: `leaf-${agent.agent_id}`,
      };
    });
    sessions.openRuntime.mockImplementation(async () => {
      order.push("runtime");
      return childRuntime();
    });

    const spawned = await coordinator.spawn(
      "root",
      { task: "Investigate", agent_id: "worker" },
      caller,
    );
    await coordinator.wait("root", "worker", 1_000);
    expect(order).toEqual(["identity", "runtime"]);
    expect(spawned.agent_id).toBe("worker");

    const failedFixture = coordinatorFixture();
    failedFixture.sessions.createIdentity.mockImplementation(() => {
      throw new Error("identity disk full");
    });
    await expect(
      failedFixture.coordinator.spawn("root", { task: "Fail safely", agent_id: "failed" }, caller),
    ).rejects.toThrow("identity disk full");
    expect(failedFixture.sessions.openRuntime).not.toHaveBeenCalled();
    expect(failedFixture.coordinator.snapshot().agents).toEqual([]);

    const leaflessFixture = coordinatorFixture();
    leaflessFixture.sessions.createIdentity.mockReturnValue({
      sessionFile: "/sessions/leafless.jsonl",
      sessionId: "session-leafless",
    });
    await expect(
      leaflessFixture.coordinator.spawn(
        "root",
        { task: "Require a selected leaf", agent_id: "leafless" },
        caller,
      ),
    ).rejects.toThrow("no selected session leaf for leafless");
    expect(leaflessFixture.registryEvents).toEqual([]);
  });

  it("persists an authorized spawn and lets the direct parent wait for its exact turn", async () => {
    const { coordinator } = coordinatorFixture();
    const spawned = await coordinator.spawn(
      "root",
      { task: "Investigate", agent_id: "worker" },
      caller,
    );
    const result = await coordinator.wait("root", "worker", 1_000);
    expect(spawned).toMatchObject({ agent_id: "worker", status: "running" });
    expect(result).toMatchObject({ agent_id: "worker", status: "completed", output: "done" });
    const status = coordinator.status("root");
    expect("agents" in status ? status.agents : []).toHaveLength(1);
    expect(() => coordinator.status("other", "worker")).toThrow(
      "Minimal subagents unknown agent: other",
    );
  });

  it("reports the live Runtime Profile while preserving the Launch Contract and nested defaults", async () => {
    const runtime = childRuntime();
    const { coordinator } = coordinatorFixture(runtime);
    await coordinator.spawn("root", { task: "Inspect", agent_id: "worker" }, caller);
    await coordinator.wait("root", "worker", 1_000);
    runtime.getRuntimeProfile.mockReturnValue({
      model: "live/provider/model:variant",
      thinking_level: "high",
    });
    runtime.snapshotActivityMessages.mockReturnValue([
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [{ type: "text", text: "committed child work" }],
        isError: false,
        timestamp: 1,
      },
    ]);

    expect(coordinator.status("root")).toMatchObject({
      agents: [
        {
          agent_id: "worker",
          model: "live/provider/model:variant",
          thinking_level: "high",
        },
      ],
    });
    expect(coordinator.inspectStatus()).toMatchObject({
      agents: [
        {
          agent_id: "worker",
          model: "live/provider/model:variant",
          thinking_level: "high",
        },
      ],
    });
    expect(coordinator.status("root", "worker")).toMatchObject({
      agent: {
        model: "live/provider/model:variant",
        thinking_level: "high",
        launch_contract: {
          model: "provider/model",
          thinking_level: "medium",
        },
        recent_activity: [
          {
            label: "tool result read",
            content: "committed child work",
          },
        ],
      },
    });
    expect(coordinator.inspectStatus("worker")).toMatchObject({
      agent: {
        model: "live/provider/model:variant",
        thinking_level: "high",
        launch_contract: {
          model: "provider/model",
          thinking_level: "medium",
        },
      },
    });
    runtime.getRuntimeProfile.mockReturnValue(undefined);
    expect(coordinator.status("root", "worker")).toMatchObject({
      agent: { model: "provider/model", thinking_level: "medium" },
    });
    expect(coordinator.snapshotChildCaller("worker", "nested-entry")).toMatchObject({
      model: "provider/model",
      thinkingLevel: "medium",
      spawnEntryId: "nested-entry",
    });
  });

  it("lazily exposes only the requested live Child Agent transcript", async () => {
    const runtime = childRuntime();
    runtime.snapshotActivityTranscript.mockReturnValue({
      messages: [
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read",
          content: [{ type: "text", text: "visible work" }],
          isError: false,
          timestamp: 1,
        },
      ],
      toolDefinitions: [],
    });
    const { coordinator } = coordinatorFixture(runtime);
    await coordinator.spawn("root", { task: "Inspect", agent_id: "worker" }, caller);
    await coordinator.wait("root", "worker", 1_000);

    coordinator.inspectStatus();
    expect(runtime.snapshotActivityTranscript).not.toHaveBeenCalled();
    expect(coordinator.inspectTranscript("worker")).toMatchObject({
      messages: [{ role: "toolResult", toolCallId: "call-1" }],
    });
    expect(runtime.snapshotActivityTranscript).toHaveBeenCalledOnce();
  });

  it("falls back to the Launch Contract before initialization and for unavailable agents", async () => {
    let resolveRuntime!: (runtime: ChildAgentRuntime) => void;
    const runtimeInitialization = new Promise<ChildAgentRuntime>((resolve) => {
      resolveRuntime = resolve;
    });
    const pending = coordinatorFixture();
    pending.sessions.openRuntime.mockReturnValue(runtimeInitialization);
    await pending.coordinator.spawn("root", { task: "Wait", agent_id: "pending" }, caller);
    const beforeInitialization = pending.coordinator.status("root");
    resolveRuntime(childRuntime());
    await pending.coordinator.wait("root", "pending", 1_000);
    expect(beforeInitialization).toMatchObject({
      agents: [{ model: "provider/model", thinking_level: "medium" }],
    });

    const unavailable = coordinatorFixture();
    unavailable.sessions.resolveRestorationMissingDependencies.mockResolvedValue([
      `provider/${"missing".repeat(500)}`,
    ]);
    const longFailure = "restoration failed\n".repeat(300);
    await unavailable.coordinator.restore({
      agents: [
        {
          ...persistedAgent("missing", "root"),
          latest_result: {
            agent_id: "missing",
            turn_id: "missing:turn-1",
            status: "failed",
            output: "",
            error: longFailure,
          },
        },
      ],
      tombstones: [],
      deliveries: [],
    });
    expect(unavailable.coordinator.inspectStatus("missing")).toMatchObject({
      agent: {
        availability: "unavailable",
        model: "provider/model",
        thinking_level: "medium",
      },
    });
    const fallback = unavailable.coordinator.inspectTranscript("missing").fallback ?? "";
    expect(fallback).toContain("missing");
    expect(Buffer.byteLength(fallback, "utf8")).toBeLessThanOrEqual(2 * 1024);
  });

  it("supports abortable waits and recursive cancellation/deletion authorization", async () => {
    let finishPrompt!: (outcome: RuntimeTurnOutcome) => void;
    const runtime = childRuntime();
    runtime.runPrompt.mockImplementation(
      () => new Promise<RuntimeTurnOutcome>((resolve) => (finishPrompt = resolve)),
    );
    runtime.abort.mockImplementation(async (): Promise<void> => {
      finishPrompt({ status: "cancelled", output: "" });
    });
    const { coordinator, sessions } = coordinatorFixture(runtime);
    await coordinator.spawn("root", { task: "Wait", agent_id: "worker" }, caller);
    const abortController = new AbortController();
    const waiting = coordinator.wait("root", "worker", undefined, abortController.signal);
    abortController.abort();
    await expect(waiting).rejects.toThrow("Minimal subagents wait cancelled for worker");
    expect(await coordinator.cancel("root", "worker", true)).toMatchObject({
      affected_agent_ids: ["worker"],
    });
    expect((await coordinator.delete("root", "worker", true)).deleted_agent_ids).toEqual([
      "worker",
    ]);
    expect(sessions.trashSession).toHaveBeenCalledWith(
      expect.objectContaining({ agent_id: "worker", session_file: "/sessions/worker.jsonl" }),
    );
  });

  it("rejects a concurrent duplicate wait from the same caller for one turn", async () => {
    const runtime = childRuntime();
    runtime.runPrompt.mockImplementation(() => new Promise<RuntimeTurnOutcome>(() => undefined));
    const { coordinator } = coordinatorFixture(runtime);
    const spawned = await coordinator.spawn(
      "root",
      { task: "Wait once", agent_id: "worker" },
      caller,
    );
    await vi.waitFor(() => expect(runtime.runPrompt).toHaveBeenCalledOnce());
    const abortController = new AbortController();
    const firstWait = coordinator.wait(
      "root",
      "worker",
      undefined,
      abortController.signal,
      spawned.turn_id,
    );

    await expect(
      coordinator.wait("root", "worker", undefined, undefined, spawned.turn_id),
    ).rejects.toThrow(
      `Minimal subagents duplicate wait: root is already waiting for ${spawned.turn_id}`,
    );
    abortController.abort();
    await expect(firstWait).rejects.toThrow("Minimal subagents wait cancelled for worker");
    await coordinator.cancel("root", "worker");
  });

  it("returns detailed child status when one waiter times out without cancelling", async () => {
    let finishPrompt!: (outcome: RuntimeTurnOutcome) => void;
    const runtime = childRuntime();
    runtime.runPrompt.mockImplementation(
      () => new Promise<RuntimeTurnOutcome>((resolve) => (finishPrompt = resolve)),
    );
    runtime.abort.mockImplementation(async (): Promise<void> => {
      finishPrompt({ status: "cancelled", output: "" });
    });
    const { coordinator } = coordinatorFixture(runtime);
    const spawned = await coordinator.spawn("root", { task: "Wait", agent_id: "worker" }, caller);
    await expect(coordinator.wait("root", "worker", 1)).resolves.toMatchObject({
      event: "timeout",
      agent_id: "worker",
      turn_id: spawned.turn_id,
      timeout_ms: 1,
      agent: {
        agent_id: "worker",
        state: "running",
        active_turn_id: spawned.turn_id,
        launch_contract: { model: "provider/model" },
      },
    });
    expect(runtime.abort).not.toHaveBeenCalled();
    finishPrompt({ status: "completed", output: "completed after timeout" });
    await expect(coordinator.wait("root", "worker", 1_000)).resolves.toMatchObject({
      event: "turn",
      turn_id: spawned.turn_id,
      status: "completed",
      output: "completed after timeout",
    });
  });

  it("allows fanout only within the configured depth and denies non-fanout callers", async () => {
    const { coordinator } = coordinatorFixture();
    await coordinator.restore({
      agents: [persistedAgent("parent", "root", "fanout")],
      tombstones: [],
      deliveries: [],
    });
    const nested = await coordinator.spawn("parent", { task: "Nested", agent_id: "child" }, caller);
    await coordinator.wait("parent", "parent.child", 1_000);
    expect(nested.agent_id).toBe("parent.child");
    await expect(
      coordinator.spawn("parent.child", { task: "Too deep", agent_id: "grandchild" }, caller),
    ).rejects.toThrow("Minimal subagents maximum delegation depth reached");

    const denied = coordinatorFixture();
    await denied.coordinator.restore({
      agents: [persistedAgent("ordinary", "root", "none")],
      tombstones: [],
      deliveries: [],
    });
    await expect(
      denied.coordinator.spawn("ordinary", { task: "Not authorized", agent_id: "child" }, caller),
    ).rejects.toThrow("Minimal subagents delegation denied");
  });

  it("does not re-mark a Coordination Message after synchronous evidence settlement", async () => {
    const runtime = childRuntime();
    Object.defineProperty(runtime, "isRunning", { value: true });
    const fixture = coordinatorFixture(runtime);
    await fixture.coordinator.restore({
      agents: [persistedAgent("source", "root"), persistedAgent("sibling", "root")],
      tombstones: [],
      deliveries: [],
    });
    let deliveredId: string | undefined;
    runtime.queueCoordinatorMessage.mockImplementation(async (message) => {
      deliveredId = message.details.delivery_id;
      await fixture.coordinator.reconcileDeliveries();
    });
    runtime.hasDeliveryEvidence.mockImplementation(
      (_sourceAgentId, _sourceTurnId, deliveryId) => deliveryId === deliveredId,
    );

    await fixture.coordinator.sendAgentMessage(
      "source",
      { agent_id: "sibling", message: "settle synchronously" },
      "source:turn",
    );

    expect(fixture.coordinator.snapshot().coordination_deliveries).toEqual([]);
    expect(fixture.registryEvents).toContainEqual(
      expect.objectContaining({
        version: 2,
        event: "agent-message-recorded",
        recorded_at: "2026-01-01T00:00:00.000Z",
      }),
    );
    await fixture.coordinator.reconcileDeliveries(true);
    expect(runtime.queueCoordinatorMessage).toHaveBeenCalledOnce();
  });

  it("delivers explicit and automatic messages once after durable evidence appears", async () => {
    const explicit = coordinatorFixture();
    await explicit.coordinator.restore({
      agents: [persistedAgent("child", "root")],
      tombstones: [],
      deliveries: [],
    });
    await expect(
      explicit.coordinator.sendAgentMessage(
        "child",
        { message: "Need action" },
        "child:turn-message",
      ),
    ).resolves.toMatchObject({
      agent_id: "root",
      message_id: expect.any(String),
      disposition: "queued",
    });
    expect(explicit.root.queueCoordinatorMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "minimal-subagents.message",
        content: expect.stringContaining(
          "[Subagent message | agent=child | turn=child:turn-message]",
        ),
        details: expect.objectContaining({ source_turn_id: "child:turn-message" }),
      }),
    );

    const automatic = coordinatorFixture();
    const spawned = await automatic.coordinator.spawn(
      "root",
      { task: "Complete", agent_id: "worker" },
      caller,
    );
    await automatic.coordinator.waitForSettledOperations();
    expect(automatic.root.queueCoordinatorMessage).toHaveBeenCalledOnce();
    expect(automatic.root.queueCoordinatorMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "minimal-subagents.result",
        details: expect.objectContaining({ source_turn_id: spawned.turn_id }),
      }),
    );
    automatic.root.hasDeliveryEvidence.mockReturnValue(true);
    await automatic.coordinator.reconcileDeliveries(true);
    await automatic.coordinator.reconcileDeliveries(true);
    expect(automatic.root.queueCoordinatorMessage).toHaveBeenCalledOnce();
    expect(
      automatic.registryEvents.filter(
        (event) => event.event === "delivery-settled" && event.source_turn_id === spawned.turn_id,
      ),
    ).toHaveLength(1);
  });

  it("returns a direct child message through an active wait before the terminal result", async () => {
    let finishPrompt!: (outcome: RuntimeTurnOutcome) => void;
    const runtime = childRuntime();
    runtime.runPrompt.mockImplementation(
      () => new Promise<RuntimeTurnOutcome>((resolve) => (finishPrompt = resolve)),
    );
    const { coordinator, root } = coordinatorFixture(runtime);
    const spawned = await coordinator.spawn(
      "root",
      { task: "Ask for context", agent_id: "worker" },
      caller,
    );
    const terminalOrMessage = coordinator.wait("root", "worker", 1_000);

    await expect(
      coordinator.sendAgentMessage(
        "worker",
        { message: "Please provide the session paths" },
        spawned.turn_id,
      ),
    ).resolves.toMatchObject({
      agent_id: "root",
      disposition: "delivered-via-wait",
      message_id: expect.any(String),
    });
    await expect(terminalOrMessage).resolves.toMatchObject({
      event: "message",
      agent_id: "worker",
      turn_id: spawned.turn_id,
      message: "Please provide the session paths",
    });
    expect(root.queueCoordinatorMessage).not.toHaveBeenCalled();

    const terminal = coordinator.wait("root", "worker", 1_000);
    finishPrompt({ status: "completed", output: "Reviewed the sessions" });
    await expect(terminal).resolves.toMatchObject({
      event: "turn",
      status: "completed",
      output: "Reviewed the sessions",
    });
    expect(root.queueCoordinatorMessage).not.toHaveBeenCalled();
  });

  it("automatically delivers the terminal result when an intermediate message ends the wait", async () => {
    let finishPrompt!: (outcome: RuntimeTurnOutcome) => void;
    const runtime = childRuntime();
    runtime.runPrompt.mockImplementation(
      () => new Promise<RuntimeTurnOutcome>((resolve) => (finishPrompt = resolve)),
    );
    const { coordinator, root } = coordinatorFixture(runtime, 5);
    const spawned = await coordinator.spawn(
      "root",
      { task: "Report progress", agent_id: "worker" },
      caller,
    );
    const wait = coordinator.wait("root", "worker", 1_000);

    await coordinator.sendAgentMessage("worker", { message: "progress" }, spawned.turn_id);
    await expect(wait).resolves.toMatchObject({ event: "message", message: "progress" });
    finishPrompt({ status: "completed", output: "complete" });
    await vi.waitFor(() =>
      expect(coordinator.snapshot().deliveries).toContainEqual(
        expect.objectContaining({ source_turn_id: spawned.turn_id, path: "message" }),
      ),
    );

    await coordinator.waitForSettledOperations();

    expect(root.queueCoordinatorMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "minimal-subagents.result",
        details: expect.objectContaining({ source_turn_id: spawned.turn_id }),
      }),
    );
  });

  it("lets a wait claim a queued direct-parent message sent just before it", async () => {
    let finishPrompt!: (outcome: RuntimeTurnOutcome) => void;
    const runtime = childRuntime();
    runtime.runPrompt.mockImplementation(
      () => new Promise<RuntimeTurnOutcome>((resolve) => (finishPrompt = resolve)),
    );
    const { coordinator, root } = coordinatorFixture(runtime, 20);
    const spawned = await coordinator.spawn(
      "root",
      { task: "Ask for context", agent_id: "worker" },
      caller,
    );
    await vi.waitFor(() => expect(runtime.runPrompt).toHaveBeenCalledOnce());

    await expect(
      coordinator.sendAgentMessage(
        "worker",
        { message: "Please provide the session paths" },
        spawned.turn_id,
      ),
    ).resolves.toMatchObject({ disposition: "queued" });
    await expect(
      coordinator.sendAgentMessage(
        "worker",
        { message: "Also report the relevant timestamps" },
        spawned.turn_id,
      ),
    ).resolves.toMatchObject({ disposition: "queued" });
    expect(root.queueCoordinatorMessage).not.toHaveBeenCalled();

    const message = await coordinator.wait("root", "worker", 1_000);
    expect(message).toMatchObject({
      event: "message",
      agent_id: "worker",
      turn_id: spawned.turn_id,
      message: "Please provide the session paths",
    });
    await expect(coordinator.wait("root", "worker", 1_000)).resolves.toMatchObject({
      event: "message",
      message: "Also report the relevant timestamps",
    });

    const terminal = coordinator.wait("root", "worker", 1_000);
    finishPrompt({ status: "completed", output: "Reviewed the sessions" });
    await expect(terminal).resolves.toMatchObject({ event: "turn", status: "completed" });
    await coordinator.waitForSettledOperations();
    expect(root.queueCoordinatorMessage).not.toHaveBeenCalled();
  });

  it("batches queued direct-parent messages into one steer", async () => {
    const { coordinator, queuedMessages } = coordinatorFixture(childRuntime(), 5);
    await coordinator.restore({
      agents: [persistedAgent("worker", "root")],
      tombstones: [],
      deliveries: [],
    });

    await coordinator.sendAgentMessage("worker", { message: "progress 1" }, "worker:turn");
    await coordinator.sendAgentMessage("worker", { message: "progress 2" }, "worker:turn");
    await coordinator.waitForSettledOperations();

    expect(queuedMessages).toHaveLength(1);
    expect(queuedMessages[0]).toMatchObject({
      customType: "minimal-subagents.message",
      content: expect.stringContaining("progress 1"),
      details: {
        source_agent_id: "worker",
        source_turn_id: "worker:turn",
        messages: [
          { delivery_id: expect.any(String), message_id: expect.any(String) },
          { delivery_id: expect.any(String), message_id: expect.any(String) },
        ],
      },
    });
    expect(queuedMessages[0]?.content).toContain("progress 2");
  });

  it("steers later coordination messages after an earlier wait event", async () => {
    let finishPrompt!: (outcome: RuntimeTurnOutcome) => void;
    const runtime = childRuntime();
    runtime.runPrompt.mockImplementation(
      () => new Promise<RuntimeTurnOutcome>((resolve) => (finishPrompt = resolve)),
    );
    const { coordinator, root } = coordinatorFixture(runtime, 5);
    const spawned = await coordinator.spawn(
      "root",
      { task: "Report progress", agent_id: "worker" },
      caller,
    );
    const firstWait = coordinator.wait("root", "worker", 1_000);

    await coordinator.sendAgentMessage("worker", { message: "progress 1" }, spawned.turn_id);
    await expect(firstWait).resolves.toMatchObject({
      event: "message",
      message: "progress 1",
    });
    await coordinator.sendAgentMessage("worker", { message: "progress 2" }, spawned.turn_id);
    await new Promise((resolve) => setTimeout(resolve, 20));
    finishPrompt({ status: "completed", output: "complete" });
    await vi.waitFor(() =>
      expect(coordinator.inspectStatus("worker")).toMatchObject({
        agent: { state: "idle" },
      }),
    );

    await expect(coordinator.wait("root", "worker", 1_000)).resolves.toMatchObject({
      event: "turn",
      status: "completed",
      output: "complete",
    });
    await coordinator.waitForSettledOperations();
    expect(root.queueCoordinatorMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("progress 2") }),
    );
  });

  it("rejects old waiters and abandons old runtime completion on branch restore", async () => {
    let finishOldPrompt!: (outcome: RuntimeTurnOutcome) => void;
    const oldRuntime = childRuntime();
    Object.defineProperty(oldRuntime, "isRunning", { value: true });
    oldRuntime.runPrompt.mockImplementation(
      () => new Promise<RuntimeTurnOutcome>((resolve) => (finishOldPrompt = resolve)),
    );
    const fixture = coordinatorFixture(oldRuntime, 5);
    await fixture.coordinator.spawn(
      "root",
      { task: "Run on abandoned branch", agent_id: "worker" },
      caller,
    );
    await vi.waitFor(() => expect(oldRuntime.runPrompt).toHaveBeenCalledOnce());
    const oldWait = fixture.coordinator.wait("root", "worker", 1_000);

    await fixture.coordinator.restore({ agents: [], tombstones: [], deliveries: [] });
    await expect(oldWait).rejects.toThrow("session branch changed");
    expect(oldRuntime.abort).toHaveBeenCalledOnce();
    finishOldPrompt({ status: "completed", output: "must not leak" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(fixture.coordinator.snapshot().agents).toEqual([]);
    expect(fixture.root.queueCoordinatorMessage).not.toHaveBeenCalled();
  });

  it("persists eviction of only the oldest wait-only terminal result after 20 per source", async () => {
    let finishMessage!: (outcome: RuntimeTurnOutcome) => void;
    const runtime = childRuntime();
    runtime.runMessage.mockImplementation(
      () => new Promise<RuntimeTurnOutcome>((resolve) => (finishMessage = resolve)),
    );
    const fixture = coordinatorFixture(runtime);
    await fixture.coordinator.restore({
      agents: [persistedAgent("worker", "root")],
      tombstones: [],
      deliveries: [],
    });

    for (let index = 1; index <= 21; index++) {
      await fixture.coordinator.sendAgentMessage(
        "root",
        { agent_id: "worker", message: `request ${index}` },
        `root:turn-${index}`,
      );
      await vi.waitFor(() => expect(runtime.runMessage).toHaveBeenCalledTimes(index));
      const status = fixture.coordinator.inspectStatus("worker");
      const activeTurnId = "agent" in status ? status.agent.active_turn_id : undefined;
      if (!activeTurnId) throw new Error("worker turn did not start");
      const wait = fixture.coordinator.wait("root", "worker", 1_000, undefined, activeTurnId);
      finishMessage({ status: "completed", output: `result ${index}` });
      await wait;
    }

    const snapshot = fixture.coordinator.snapshot();
    expect(snapshot.deliveries).toHaveLength(20);
    expect(snapshot.coordination_deliveries).toHaveLength(21);
    expect(snapshot.deliveries.map((delivery) => delivery.result?.output)).not.toContain(
      "result 1",
    );
    expect(fixture.registryEvents).toContainEqual(
      expect.objectContaining({
        version: 2,
        event: "delivery-pruned",
        source_agent_id: "worker",
        reason: "retention-limit",
      }),
    );
  });

  it("restores unclaimed later messages and terminal results through automatic fallback", async () => {
    let finishPrompt!: (outcome: RuntimeTurnOutcome) => void;
    const runtime = childRuntime();
    runtime.runPrompt.mockImplementation(
      () => new Promise<RuntimeTurnOutcome>((resolve) => (finishPrompt = resolve)),
    );
    const source = coordinatorFixture(runtime, 200);
    const spawned = await source.coordinator.spawn(
      "root",
      { task: "Report through reload", agent_id: "worker" },
      caller,
    );
    const firstWait = source.coordinator.wait("root", "worker", 1_000);
    await source.coordinator.sendAgentMessage("worker", { message: "progress 1" }, spawned.turn_id);
    const first = await firstWait;
    if (first.event !== "message") throw new Error("expected the first wait event to be a message");
    expect(first).toMatchObject({ event: "message", message: "progress 1" });
    source.root.hasDeliveryEvidence.mockImplementation(
      (_agentId: string, _turnId: string, deliveryId?: string) => deliveryId === first.delivery_id,
    );
    await source.coordinator.reconcileDeliveries();
    await source.coordinator.sendAgentMessage("worker", { message: "progress 2" }, spawned.turn_id);
    finishPrompt({ status: "completed", output: "complete after reload" });
    await vi.waitFor(() =>
      expect(source.coordinator.inspectStatus("worker")).toMatchObject({
        agent: { state: "idle" },
      }),
    );

    const restored = coordinatorFixture(childRuntime(), 200);
    await restored.coordinator.restore(source.coordinator.snapshot());
    expect(restored.queuedMessages).toHaveLength(1);
    expect(restored.queuedMessages[0]).toMatchObject({
      customType: "minimal-subagents.result",
      content: expect.stringContaining("progress 2"),
      details: {
        source_agent_id: "worker",
        source_turn_id: spawned.turn_id,
        messages: [{ delivery_id: expect.any(String), message_id: expect.any(String) }],
      },
    });
    expect(restored.queuedMessages[0]?.content).toContain("complete after reload");
  });

  it("requeues branch-local deliveries when the same coordinator restores", async () => {
    const fixture = coordinatorFixture();
    await fixture.coordinator.restore({
      agents: [persistedAgent("first", "root"), persistedAgent("second", "root")],
      tombstones: [],
      deliveries: [],
    });
    fixture.setRootIdle(false);

    await fixture.coordinator.sendAgentMessage(
      "first",
      { message: "first branch message" },
      "first:turn",
    );
    await vi.waitFor(() => expect(fixture.root.isIdle).toHaveBeenCalled());
    await fixture.coordinator.sendAgentMessage(
      "second",
      { message: "second branch message" },
      "second:turn",
    );

    await fixture.coordinator.restore(fixture.coordinator.snapshot());
    fixture.setRootIdle(true);

    await vi.waitFor(() => expect(fixture.queuedMessages).toHaveLength(2));
    expect(fixture.queuedMessages.map((message) => message.content)).toEqual([
      expect.stringContaining("first branch message"),
      expect.stringContaining("second branch message"),
    ]);
  });

  it("selects the oldest retained turn by default and supports an exact turn ID", async () => {
    const fixture = coordinatorFixture(childRuntime(), 200);
    const agent = persistedAgent("worker", "root");
    agent.latest_result = {
      agent_id: "worker",
      turn_id: "worker:newer",
      status: "completed",
      output: "newer result",
    };
    await fixture.coordinator.restore({
      agents: [agent],
      tombstones: [],
      deliveries: [
        {
          source_agent_id: "worker",
          source_turn_id: "worker:older",
          destination_agent_id: "root",
          path: "wait",
          settled: false,
          sequence: 1,
          result: {
            agent_id: "worker",
            turn_id: "worker:older",
            status: "completed",
            output: "older result",
          },
        },
      ],
      wait_claimed_turns: ["worker\u0000worker:older"],
      next_delivery_sequence: 2,
    });

    await expect(fixture.coordinator.wait("root", "worker", 1_000)).resolves.toMatchObject({
      turn_id: "worker:older",
      output: "older result",
    });
    await expect(
      fixture.coordinator.wait("root", "worker", 1_000, undefined, "worker:newer"),
    ).resolves.toMatchObject({ turn_id: "worker:newer", output: "newer result" });
  });

  it("lets an idle terminal wait claim and suppress scheduled automatic delivery", async () => {
    const { coordinator, root } = coordinatorFixture(childRuntime(), 200);
    const spawned = await coordinator.spawn(
      "root",
      { task: "Complete", agent_id: "worker" },
      caller,
    );
    await vi.waitFor(() =>
      expect(coordinator.snapshot().deliveries).toContainEqual(
        expect.objectContaining({
          source_turn_id: spawned.turn_id,
          path: "message",
          settled: false,
        }),
      ),
    );

    await expect(coordinator.wait("root", "worker", 1_000)).resolves.toMatchObject({
      event: "turn",
      turn_id: spawned.turn_id,
      status: "completed",
    });
    await coordinator.waitForSettledOperations();

    expect(root.queueCoordinatorMessage).not.toHaveBeenCalled();
    expect(coordinator.snapshot().deliveries).toContainEqual(
      expect.objectContaining({
        source_turn_id: spawned.turn_id,
        path: "wait",
      }),
    );
  });

  it("drains queued messages with an already settled terminal result in one wait", async () => {
    let finishPrompt!: (outcome: RuntimeTurnOutcome) => void;
    const runtime = childRuntime();
    runtime.runPrompt.mockImplementation(
      () => new Promise<RuntimeTurnOutcome>((resolve) => (finishPrompt = resolve)),
    );
    const { coordinator, root } = coordinatorFixture(runtime, 200);
    const spawned = await coordinator.spawn(
      "root",
      { task: "Report before completing", agent_id: "worker" },
      caller,
    );
    await vi.waitFor(() => expect(runtime.runPrompt).toHaveBeenCalledOnce());
    await coordinator.sendAgentMessage("worker", { message: "progress" }, spawned.turn_id);
    finishPrompt({ status: "completed", output: "complete" });
    await vi.waitFor(() =>
      expect(coordinator.inspectStatus("worker")).toMatchObject({ agent: { state: "idle" } }),
    );

    await expect(coordinator.wait("root", "worker", 1_000)).resolves.toMatchObject({
      event: "turn",
      status: "completed",
      output: "complete",
      messages: [{ event: "message", message: "progress" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    await coordinator.waitForSettledOperations();

    expect(root.queueCoordinatorMessage).not.toHaveBeenCalled();
  });

  it("batches queued coordination messages into the automatic terminal result", async () => {
    let finishPrompt!: (outcome: RuntimeTurnOutcome) => void;
    const runtime = childRuntime();
    runtime.runPrompt.mockImplementation(
      () => new Promise<RuntimeTurnOutcome>((resolve) => (finishPrompt = resolve)),
    );
    const { coordinator, queuedMessages } = coordinatorFixture(runtime, 5);
    const spawned = await coordinator.spawn(
      "root",
      { task: "Report without a wait", agent_id: "worker" },
      caller,
    );
    await vi.waitFor(() => expect(runtime.runPrompt).toHaveBeenCalledOnce());
    await coordinator.sendAgentMessage("worker", { message: "progress 1" }, spawned.turn_id);
    await coordinator.sendAgentMessage("worker", { message: "progress 2" }, spawned.turn_id);
    finishPrompt({ status: "completed", output: "complete" });
    await coordinator.waitForSettledOperations();

    expect(queuedMessages).toHaveLength(1);
    expect(queuedMessages[0]).toMatchObject({
      customType: "minimal-subagents.result",
      content: expect.stringContaining("progress 1"),
      details: {
        source_agent_id: "worker",
        source_turn_id: spawned.turn_id,
        messages: [
          { delivery_id: expect.any(String), message_id: expect.any(String) },
          { delivery_id: expect.any(String), message_id: expect.any(String) },
        ],
      },
    });
    expect(queuedMessages[0]?.content).toContain("progress 2");
    expect(queuedMessages[0]?.content).toContain("complete");
  });

  it("keeps root-bound messages batchable while the root turn is active", async () => {
    let finishPrompt!: (outcome: RuntimeTurnOutcome) => void;
    const runtime = childRuntime();
    runtime.runPrompt.mockImplementation(
      () => new Promise<RuntimeTurnOutcome>((resolve) => (finishPrompt = resolve)),
    );
    const fixture = coordinatorFixture(runtime, 5);
    fixture.setRootIdle(false);
    const spawned = await fixture.coordinator.spawn(
      "root",
      { task: "Report across model round trips", agent_id: "worker" },
      caller,
    );
    await vi.waitFor(() => expect(runtime.runPrompt).toHaveBeenCalledOnce());

    await fixture.coordinator.sendAgentMessage(
      "worker",
      { message: "progress before delay" },
      spawned.turn_id,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fixture.queuedMessages).toHaveLength(0);
    await fixture.coordinator.sendAgentMessage(
      "worker",
      { message: "progress after delay" },
      spawned.turn_id,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fixture.queuedMessages).toHaveLength(0);

    finishPrompt({ status: "completed", output: "complete" });
    await fixture.coordinator.waitForSettledOperations();

    expect(fixture.queuedMessages).toHaveLength(1);
    expect(fixture.queuedMessages[0]?.content).toContain("progress before delay");
    expect(fixture.queuedMessages[0]?.content).toContain("progress after delay");
    expect(fixture.queuedMessages[0]?.content).toContain("complete");
  });

  it("reserves automatic result delivery before later recipient messages", async () => {
    let finishPrompt!: (outcome: RuntimeTurnOutcome) => void;
    const runtime = childRuntime();
    runtime.runPrompt.mockImplementation(
      () => new Promise<RuntimeTurnOutcome>((resolve) => (finishPrompt = resolve)),
    );
    const { coordinator, queuedMessages } = coordinatorFixture(runtime, 10);
    const spawned = await coordinator.spawn(
      "root",
      { task: "Complete", agent_id: "worker" },
      caller,
    );
    await vi.waitFor(() => expect(runtime.runPrompt).toHaveBeenCalledOnce());

    finishPrompt({ status: "completed", output: "terminal result" });
    await vi.waitFor(() => expect(coordinator.snapshot().deliveries).toHaveLength(1));
    await coordinator.sendAgentMessage(
      "worker",
      { message: "message after the turn" },
      "worker:next-turn",
    );
    await coordinator.waitForSettledOperations();

    expect(queuedMessages.map((message) => message.customType)).toEqual([
      "minimal-subagents.result",
      "minimal-subagents.message",
    ]);
    expect(queuedMessages[0]).toMatchObject({
      content: expect.stringContaining(`turn=${spawned.turn_id}`),
    });
  });

  it("prunes pending delivery state when deleting its agent subtree", async () => {
    const { coordinator } = coordinatorFixture();
    await coordinator.restore({
      agents: [persistedAgent("worker", "root")],
      tombstones: [],
      deliveries: [
        {
          source_agent_id: "worker",
          source_turn_id: "worker:pending",
          destination_agent_id: "root",
          path: "wait",
          settled: false,
          sequence: 2,
          result: {
            agent_id: "worker",
            turn_id: "worker:pending",
            status: "completed",
            output: "pending",
          },
        },
      ],
      coordination_deliveries: [
        {
          delivery_id: "message:pending",
          sequence: 1,
          destination_agent_id: "root",
          path: "wait",
          settled: false,
          message: {
            customType: "minimal-subagents.message",
            content: "pending message",
            details: {
              source_agent_id: "worker",
              destination_agent_id: "root",
              source_turn_id: "worker:pending",
              message_id: "pending",
              delivery_id: "message:pending",
            },
          },
        },
      ],
      wait_claimed_turns: ["worker\u0000worker:pending"],
      next_delivery_sequence: 3,
    });

    await coordinator.delete("root", "worker");
    expect(coordinator.snapshot()).toMatchObject({
      deliveries: [],
      coordination_deliveries: [],
      wait_claimed_turns: [],
    });
  });

  it("prunes recent-message projections sourced from a deleted subtree", async () => {
    const { coordinator } = coordinatorFixture();
    const deleted = persistedAgent("deleted", "root");
    const observer = persistedAgent("observer", "root");
    observer.recent_messages = [
      { source_agent_id: "deleted", turn_id: "deleted:old", content: "remove" },
      { source_agent_id: "root", turn_id: "root:kept", content: "keep" },
    ];
    await coordinator.restore({
      agents: [deleted, observer],
      tombstones: [],
      deliveries: [],
    });

    await coordinator.delete("root", "deleted");

    expect(coordinator.snapshot().agents).toMatchObject([
      { agent_id: "observer", recent_messages: [{ content: "keep" }] },
    ]);
  });

  it("recursively deletes descendants post-order and durably tombstones every deleted ID", async () => {
    const { coordinator, sessions } = coordinatorFixture();
    await coordinator.restore({
      agents: [persistedAgent("team", "root"), persistedAgent("team.worker", "team")],
      tombstones: [],
      deliveries: [],
    });
    const result = await coordinator.delete("root", "team", true);
    expect(result.deleted_agent_ids).toEqual(["team.worker", "team"]);
    expect(sessions.trashSession.mock.calls.map(([agent]) => agent.session_file)).toEqual([
      "/sessions/team.worker.jsonl",
      "/sessions/team.jsonl",
    ]);
    expect(coordinator.snapshot()).toMatchObject({
      agents: [],
      tombstones: ["team.worker", "team"],
    });
    await expect(
      coordinator.spawn("root", { task: "Reuse", agent_id: "team" }, caller),
    ).rejects.toThrow("Minimal subagents agent ID is tombstoned: team");
  });

  it("restores interrupted, missing, clone-failed, and runtime-failed agents as explicit states", async () => {
    const { coordinator, notify, sessions } = coordinatorFixture();
    const interrupted = persistedAgent("interrupted", "root");
    interrupted.active_turn_id = "interrupted:turn-active";
    interrupted.active_turn_started_at = "2026-01-01T00:00:00.000Z";
    const missing = persistedAgent("missing", "root");
    const cloneFailed = persistedAgent("clone-failed", "root");
    cloneFailed.clone_error = "fork disk full";
    const runtimeFailed = persistedAgent("runtime-failed", "root");
    sessions.resolveRestorationMissingDependencies.mockImplementation(
      async (agent: PersistedAgent) => (agent.agent_id === "missing" ? ["custom_tool"] : []),
    );
    sessions.openRuntime.mockImplementation(async (agent: PersistedAgent) => {
      if (agent.agent_id === "runtime-failed") throw new Error("session corrupt");
      return childRuntime();
    });

    await coordinator.restore({
      agents: [interrupted, missing, cloneFailed, runtimeFailed],
      tombstones: [],
      deliveries: [],
    });

    expect(coordinator.inspectStatus("interrupted")).toMatchObject({
      agent: {
        availability: "available",
        latest_result: { status: "interrupted", error: expect.stringContaining("process exited") },
      },
    });
    expect(coordinator.inspectStatus("missing")).toMatchObject({
      agent: {
        availability: "unavailable",
        missing_dependencies: ["custom_tool"],
        unavailable_reason: "Missing dependencies: custom_tool",
      },
    });
    expect(coordinator.inspectStatus("clone-failed")).toMatchObject({
      agent: { availability: "unavailable", unavailable_reason: "fork disk full" },
    });
    expect(coordinator.inspectStatus("runtime-failed")).toMatchObject({
      agent: { availability: "unavailable", unavailable_reason: "session corrupt" },
    });
    expect(notify.mock.calls.map(([notification]) => notification.type)).toEqual(
      expect.arrayContaining(["interruption", "restoration", "unavailable"]),
    );
  });

  it("isolates restoration dependency discovery failures per agent", async () => {
    const { coordinator, sessions } = coordinatorFixture();
    sessions.resolveRestorationMissingDependencies.mockImplementation(
      async (agent: PersistedAgent) => {
        if (agent.agent_id === "broken") throw new Error("discovery exploded");
        return [];
      },
    );

    await coordinator.restore({
      agents: [persistedAgent("broken", "root"), persistedAgent("healthy", "root")],
      tombstones: [],
      deliveries: [],
    });

    expect(coordinator.inspectStatus("broken")).toMatchObject({
      agent: { availability: "unavailable", unavailable_reason: "discovery exploded" },
    });
    expect(coordinator.inspectStatus("healthy")).toMatchObject({
      agent: { availability: "available" },
    });
    expect(sessions.openRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ agent_id: "healthy" }),
    );
  });

  it("prepares a fork by cancelling active root work and cloning its session", async () => {
    let finishPrompt!: (outcome: RuntimeTurnOutcome) => void;
    const runtime = childRuntime();
    runtime.runPrompt.mockImplementation(
      () => new Promise<RuntimeTurnOutcome>((resolve) => (finishPrompt = resolve)),
    );
    runtime.abort.mockImplementation(async (): Promise<void> => {
      finishPrompt({ status: "cancelled", output: "" });
    });
    const { coordinator } = coordinatorFixture(runtime);
    await coordinator.spawn("root", { task: "Long task", agent_id: "worker" }, caller);
    await vi.waitFor(() => expect(runtime.runPrompt).toHaveBeenCalledOnce());
    const snapshot = await coordinator.prepareFork("/root/source.jsonl");
    expect(runtime.abort).toHaveBeenCalledOnce();
    expect(snapshot.agents[0]).toMatchObject({
      agent_id: "worker",
      session_file: "/fork/worker.jsonl",
      session_id: "fork-worker",
      active_turn_id: undefined,
    });
    await expect(coordinator.cancel("root", "worker")).resolves.toMatchObject({
      affected_agent_ids: ["worker"],
    });
  });

  it("drains an accepted coordination message before cloning a fork", async () => {
    const { coordinator, root, sessions } = coordinatorFixture(childRuntime(), 5);
    await coordinator.restore({
      agents: [persistedAgent("worker", "root")],
      tombstones: [],
      deliveries: [],
    });
    await coordinator.sendAgentMessage(
      "worker",
      { message: "accepted before fork" },
      "worker:turn-before-fork",
    );
    const fork = coordinator.prepareFork("/root/source.jsonl");
    await fork;

    expect(root.queueCoordinatorMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("accepted before fork") }),
    );
    expect(root.queueCoordinatorMessage.mock.invocationCallOrder[0]).toBeLessThan(
      sessions.cloneSession.mock.invocationCallOrder[0]!,
    );
  });

  it("creates failed-subtree placeholders without cloning descendants after an ancestor failure", async () => {
    const { coordinator, sessions } = coordinatorFixture();
    await coordinator.restore({
      agents: [persistedAgent("parent", "root"), persistedAgent("parent.child", "parent")],
      tombstones: [],
      deliveries: [],
    });
    sessions.cloneSession.mockImplementation(async (agent: PersistedAgent) => {
      if (agent.agent_id === "parent") throw new Error("disk full");
      return {
        sessionFile: `/fork/${agent.agent_id}.jsonl`,
        sessionId: `fork-${agent.agent_id}`,
        sessionLeafId: `fork-leaf-${agent.agent_id}`,
      };
    });
    const snapshot = await coordinator.prepareFork("/root/source.jsonl");
    expect(sessions.cloneSession).toHaveBeenCalledTimes(1);
    expect(snapshot.agents).toEqual([
      expect.objectContaining({
        agent_id: "parent",
        clone_error: "disk full",
        availability: "unavailable",
      }),
      expect.objectContaining({
        agent_id: "parent.child",
        clone_error: "Ancestor clone failed: parent",
        availability: "unavailable",
      }),
    ]);
  });
});
