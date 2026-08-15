import { describe, expect, it, vi } from "vitest";
import { MinimalSubagentsCoordinator } from "../src/minimal-subagents-coordinator.js";
import type {
  CallerSnapshot,
  ChildAgentRuntime,
  CoordinatorDependencies,
  PersistedAgent,
  RuntimeCreationRequest,
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
    sessionFile: "/sessions/runtime.jsonl",
    sessionId: "runtime-session",
    isRunning: false,
    runPrompt: vi.fn(async () => outcome),
    runMessage: vi.fn(async () => outcome),
    queueCoordinatorMessage: vi.fn<() => Promise<void>>(async () => undefined),
    abort: vi.fn<() => Promise<void>>(async () => undefined),
    dispose: vi.fn(),
    getRuntimeProfile: vi.fn<() => RuntimeProfile | undefined>(() => runtimeProfile),
    snapshotCommittedMessages: vi.fn(() => []),
    hasDeliveryEvidence: vi.fn(() => false),
    getUsage: vi.fn(() => undefined),
  } satisfies ChildAgentRuntime;
}

function coordinatorFixture(runtime = childRuntime(), automaticDeliveryGraceMs = 0) {
  const registryEvents: unknown[] = [];
  const sessions = {
    createIdentity: vi.fn<(agent: PersistedAgent) => { sessionFile: string; sessionId: string }>(
      (agent) => ({
        sessionFile: `/sessions/${agent.agent_id}.jsonl`,
        sessionId: `session-${agent.agent_id}`,
      }),
    ),
    createRuntime: vi.fn<(request: RuntimeCreationRequest) => Promise<ChildAgentRuntime>>(
      async () => runtime,
    ),
    restoreRuntime: vi.fn<(agent: PersistedAgent) => Promise<ChildAgentRuntime>>(
      async () => runtime,
    ),
    resolveLaunchMissingDependencies: vi.fn<(agent: PersistedAgent) => Promise<string[]>>(
      async () => [],
    ),
    resolveRestorationMissingDependencies: vi.fn<(agent: PersistedAgent) => Promise<string[]>>(
      async () => [],
    ),
    resolveThinkingLevel: vi.fn((_model: string, thinking: string) => thinking),
    modelSupportsImages: vi.fn(() => true),
    cloneSession: vi.fn<
      (agent: PersistedAgent) => Promise<{ sessionFile: string; sessionId: string }>
    >(async (agent) => ({
      sessionFile: `/fork/${agent.agent_id}.jsonl`,
      sessionId: `fork-${agent.agent_id}`,
    })),
    trashSessionFile: vi.fn<(sessionFile: string) => Promise<void>>(async () => undefined),
  };
  const root = {
    queueCoordinatorMessage: vi.fn(async (): Promise<void> => undefined),
    hasDeliveryEvidence: vi.fn(() => false),
    isIdle: vi.fn(() => true),
  };
  const notify = vi.fn();
  const dependencies = {
    registry: {
      rootSessionId: "root-session",
      append: (event: unknown) => registryEvents.push(event),
    },
    sessions,
    root,
    notify,
    maxSubagentDepth: 2,
    automaticDeliveryGraceMs,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  } as unknown as CoordinatorDependencies;
  return {
    coordinator: new MinimalSubagentsCoordinator(dependencies),
    notify,
    root,
    sessions,
    registryEvents,
  };
}

const caller: CallerSnapshot = {
  messages: [],
  model: "provider/model",
  thinkingLevel: "medium",
  ordinaryTools: ["read"],
  capabilityCeiling: ["read"],
  availableTools: ["read"],
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
      };
    });
    sessions.createRuntime.mockImplementation(async () => {
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
    expect(failedFixture.sessions.createRuntime).not.toHaveBeenCalled();
    expect(failedFixture.coordinator.snapshot().agents).toEqual([]);
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

  it("falls back to the Launch Contract before initialization and for unavailable agents", async () => {
    let resolveRuntime!: (runtime: ChildAgentRuntime) => void;
    const runtimeInitialization = new Promise<ChildAgentRuntime>((resolve) => {
      resolveRuntime = resolve;
    });
    const pending = coordinatorFixture();
    pending.sessions.createRuntime.mockReturnValue(runtimeInitialization);
    await pending.coordinator.spawn("root", { task: "Wait", agent_id: "pending" }, caller);
    const beforeInitialization = pending.coordinator.status("root");
    resolveRuntime(childRuntime());
    await pending.coordinator.wait("root", "pending", 1_000);
    expect(beforeInitialization).toMatchObject({
      agents: [{ model: "provider/model", thinking_level: "medium" }],
    });

    const unavailable = coordinatorFixture();
    unavailable.sessions.resolveRestorationMissingDependencies.mockResolvedValue([
      "provider/model",
    ]);
    await unavailable.coordinator.restore({
      agents: [persistedAgent("missing", "root")],
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
    expect(sessions.trashSessionFile).toHaveBeenCalledWith("/sessions/worker.jsonl");
  });

  it("times out one waiter without cancelling the child turn", async () => {
    let finishPrompt!: (outcome: RuntimeTurnOutcome) => void;
    const runtime = childRuntime();
    runtime.runPrompt.mockImplementation(
      () => new Promise<RuntimeTurnOutcome>((resolve) => (finishPrompt = resolve)),
    );
    runtime.abort.mockImplementation(async (): Promise<void> => {
      finishPrompt({ status: "cancelled", output: "" });
    });
    const { coordinator } = coordinatorFixture(runtime);
    await coordinator.spawn("root", { task: "Wait", agent_id: "worker" }, caller);
    await expect(coordinator.wait("root", "worker", 1)).rejects.toThrow(
      "Minimal subagents wait timed out for worker after 1ms",
    );
    expect(runtime.abort).not.toHaveBeenCalled();
    await coordinator.cancel("root", "worker");
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
        (event) =>
          (event as { event?: string; source_turn_id?: string }).event === "delivery-settled" &&
          (event as { source_turn_id?: string }).source_turn_id === spawned.turn_id,
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

  it("keeps later coordination messages claimable after an earlier wait event", async () => {
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
      event: "message",
      message: "progress 2",
    });
    await expect(coordinator.wait("root", "worker", 1_000)).resolves.toMatchObject({
      event: "turn",
      status: "completed",
      output: "complete",
    });
    await coordinator.waitForSettledOperations();
    expect(root.queueCoordinatorMessage).not.toHaveBeenCalled();
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

  it("lets an intermediate wait after settlement claim the existing terminal delivery", async () => {
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
      event: "message",
      message: "progress",
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    await expect(coordinator.wait("root", "worker", 1_000)).resolves.toMatchObject({
      event: "turn",
      status: "completed",
      output: "complete",
    });
    await coordinator.waitForSettledOperations();

    expect(root.queueCoordinatorMessage).not.toHaveBeenCalled();
  });

  it("keeps automatic messages deferred while the recipient is active", async () => {
    const { coordinator, root } = coordinatorFixture(childRuntime(), 5);
    root.isIdle.mockReturnValue(false);
    const spawned = await coordinator.spawn(
      "root",
      { task: "Complete while root is active", agent_id: "worker" },
      caller,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(root.queueCoordinatorMessage).not.toHaveBeenCalled();

    await expect(coordinator.wait("root", "worker", 1_000)).resolves.toMatchObject({
      event: "turn",
      turn_id: spawned.turn_id,
      status: "completed",
    });
    root.isIdle.mockReturnValue(true);
    coordinator.markRecipientIdle("root");
    await coordinator.waitForSettledOperations();

    expect(root.queueCoordinatorMessage).not.toHaveBeenCalled();
  });

  it("releases unclaimed coordination messages before the automatic terminal result", async () => {
    let finishPrompt!: (outcome: RuntimeTurnOutcome) => void;
    const runtime = childRuntime();
    runtime.runPrompt.mockImplementation(
      () => new Promise<RuntimeTurnOutcome>((resolve) => (finishPrompt = resolve)),
    );
    const { coordinator, root } = coordinatorFixture(runtime, 5);
    root.isIdle.mockReturnValue(false);
    const spawned = await coordinator.spawn(
      "root",
      { task: "Report without a wait", agent_id: "worker" },
      caller,
    );
    await vi.waitFor(() => expect(runtime.runPrompt).toHaveBeenCalledOnce());
    await coordinator.sendAgentMessage("worker", { message: "progress" }, spawned.turn_id);
    finishPrompt({ status: "completed", output: "complete" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(root.queueCoordinatorMessage).not.toHaveBeenCalled();

    root.isIdle.mockReturnValue(true);
    coordinator.markRecipientIdle("root");
    await coordinator.waitForSettledOperations();

    const deliveredTypes = root.queueCoordinatorMessage.mock.calls.map(
      (call) => (call as unknown as [{ customType: string }])[0].customType,
    );
    expect(deliveredTypes).toEqual(["minimal-subagents.message", "minimal-subagents.result"]);
  });

  it("reserves automatic result delivery before later recipient messages", async () => {
    let finishPrompt!: (outcome: RuntimeTurnOutcome) => void;
    const runtime = childRuntime();
    runtime.runPrompt.mockImplementation(
      () => new Promise<RuntimeTurnOutcome>((resolve) => (finishPrompt = resolve)),
    );
    const { coordinator, root } = coordinatorFixture(runtime, 10);
    root.isIdle.mockReturnValue(false);
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
    expect(root.queueCoordinatorMessage).not.toHaveBeenCalled();
    root.isIdle.mockReturnValue(true);
    coordinator.markRecipientIdle("root");
    await coordinator.waitForSettledOperations();

    const queuedMessages = root.queueCoordinatorMessage.mock.calls.map(
      (call) => (call as unknown as [{ customType: string; content: string }])[0],
    );
    expect(queuedMessages.map((message) => message.customType)).toEqual([
      "minimal-subagents.result",
      "minimal-subagents.message",
    ]);
    expect(queuedMessages[0]).toMatchObject({
      content: expect.stringContaining(`turn=${spawned.turn_id}`),
    });
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
    expect(result.tombstoned_agent_ids).toEqual(["team.worker", "team"]);
    expect(sessions.trashSessionFile.mock.calls.map(([sessionFile]) => sessionFile)).toEqual([
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
    sessions.restoreRuntime.mockImplementation(async (agent: PersistedAgent) => {
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
  });

  it("drains an accepted coordination message before cloning a fork", async () => {
    const { coordinator, root, sessions } = coordinatorFixture(childRuntime(), 5);
    await coordinator.restore({
      agents: [persistedAgent("worker", "root")],
      tombstones: [],
      deliveries: [],
    });
    root.isIdle.mockReturnValue(false);
    await coordinator.sendAgentMessage(
      "worker",
      { message: "accepted before fork" },
      "worker:turn-before-fork",
    );
    const fork = coordinator.prepareFork("/root/source.jsonl");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sessions.cloneSession).not.toHaveBeenCalled();

    root.isIdle.mockReturnValue(true);
    coordinator.markRecipientIdle("root");
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
      return { sessionFile: `/fork/${agent.agent_id}.jsonl`, sessionId: `fork-${agent.agent_id}` };
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
