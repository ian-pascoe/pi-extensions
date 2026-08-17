import { randomUUID } from "node:crypto";
import { assembleImportedContext, contextContainsImages } from "./minimal-subagents-context.js";
import {
  canAgentContractSpawn,
  DEFAULT_MAX_SUBAGENT_DEPTH,
  excludeCoordinatorTools,
  getSubagentDepth,
  resolveOrdinaryToolSelection,
} from "./minimal-subagents-capabilities.js";
import {
  addCoordinationDelivery,
  addTerminalDelivery,
  claimDeliveryLedgerTurn,
  createDeliveryLedger,
  deliveryLedgerSnapshot,
  findCoordinationDelivery,
  findTerminalDelivery,
  isDeliveryLedgerTurnClaimed,
  pruneDeliveryLedgerAgents,
  releaseEmptyDeliveryLedgerTurn,
  selectObservableDeliveryTurn,
  setCoordinationDeliveryError,
  setCoordinationDeliveryPath,
  setTerminalDeliveryError,
  setTerminalDeliveryPath,
  settleCoordinationDelivery,
  settleTerminalDelivery,
  type DeliveryLedger,
  type DeliveryLedgerTransition,
} from "./minimal-subagents-delivery-ledger.js";
import { addCoordinatorMessageEnvelope } from "./minimal-subagents-message-envelope.js";
import { createRegistryEvent } from "./minimal-subagents-registry.js";
import type {
  AgentDetail,
  AgentMessageDisposition,
  AgentMessageResult,
  AgentSessionFactory,
  AgentSummary,
  CallerSnapshot,
  CancelResult,
  ChildAgentRuntime,
  CoordinatorDependencies,
  CoordinatorMessage,
  DeleteResult,
  ForkSnapshot,
  HierarchyStatusResult,
  PersistedAgent,
  PersistedCoordinationDelivery,
  PersistedDelivery,
  RegistrySnapshot,
  SpawnParameters,
  SpawnResult,
  StatusResult,
  TurnId,
  TurnResult,
  WaitMessageResult,
  WaitResult,
} from "./minimal-subagents-types.js";

const FRIENDLY_AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const RESERVED_AGENT_IDS = new Set(["root", "parent"]);
const RECENT_MESSAGE_LIMIT = 20;
const DEFAULT_AUTOMATIC_DELIVERY_GRACE_MS = 1_000;

interface MessageParameters {
  agent_id?: string;
  message: string;
}

interface TurnWaiter {
  callerId: string;
  resolve: (result: WaitResult) => void;
  reject: (error: Error) => void;
  timeout?: ReturnType<typeof setTimeout>;
  abortSignal?: AbortSignal;
  abortListener?: () => void;
}

interface PendingParentMessage {
  deliveryId: string;
  message: CoordinatorMessage;
  destinationAgentId: string;
  claimed: boolean;
  claimPromise: Promise<void>;
  releaseClaim: () => void;
  cancelGrace?: () => void;
}

function agentDeliveryKey(agentId: string, turnId: string): string {
  return `${agentId}\u0000${turnId}`;
}

function terminalTurnResult(
  agentId: string,
  turnId: string,
  outcome: Awaited<ReturnType<ChildAgentRuntime["runPrompt"]>>,
): TurnResult {
  return {
    agent_id: agentId,
    turn_id: turnId,
    status: outcome.status,
    output: outcome.output,
    error: outcome.error,
    usage: outcome.usage,
  };
}

function terminalWaitResult(result: TurnResult, messages: WaitMessageResult[] = []): WaitResult {
  const terminal = { event: "turn" as const, ...structuredClone(result) };
  return messages.length === 0 ? terminal : { ...terminal, messages: structuredClone(messages) };
}

/** One root-owned coordinator for persistent nested Pi child sessions. */
export class MinimalSubagentsCoordinator {
  private readonly agents = new Map<string, PersistedAgent>();
  private readonly runtimes = new Map<string, ChildAgentRuntime>();
  private readonly runtimeInitializations = new Map<string, Promise<ChildAgentRuntime>>();
  private readonly tombstones = new Set<string>();
  private readonly pendingAgentIds = new Set<string>();
  private deliveryLedger: DeliveryLedger = createDeliveryLedger();
  private readonly waiters = new Map<string, Set<TurnWaiter>>();
  private readonly pendingParentMessages = new Map<string, PendingParentMessage[]>();
  private readonly recipientQueues = new Map<string, Promise<unknown>>();
  private readonly automaticDeliveryKeys = new Set<string>();
  private readonly automaticCoordinationDeliveryIds = new Set<string>();
  private readonly waitHandedDeliveryIds = new Set<string>();
  private readonly backgroundOperations = new Set<Promise<void>>();
  private acceptingOperations = true;
  private lifecycleEpoch = 0;
  private shutdownPromise?: Promise<void>;

  constructor(private readonly dependencies: CoordinatorDependencies) {}

  private get maxSubagentDepth(): number {
    return this.dependencies.maxSubagentDepth ?? DEFAULT_MAX_SUBAGENT_DEPTH;
  }

  /** Return a serializable complete hierarchy checkpoint without process-local runtimes. */
  snapshot(): RegistrySnapshot {
    const ledger = deliveryLedgerSnapshot(this.deliveryLedger);
    return {
      agents: [...this.agents.values()].map((agent) => structuredClone(agent)),
      tombstones: [...this.tombstones],
      ...ledger,
    };
  }

  /** Persist a complete registry checkpoint for initial ownership or fork ownership. */
  writeCheckpoint(): void {
    this.dependencies.registry.append(
      createRegistryEvent(this.dependencies.registry.rootSessionId, "checkpoint", {
        snapshot: this.snapshot(),
      }),
    );
  }

  /** Validate, persist, and schedule one asynchronous child turn. */
  async spawn(
    callerId: string,
    parameters: SpawnParameters,
    caller: CallerSnapshot,
  ): Promise<SpawnResult> {
    this.assertAccepting();
    this.assertCallerExists(callerId);
    this.assertCallerMaySpawn(callerId);
    if (parameters.task.trim().length === 0) {
      throw new Error("Minimal subagents spawn validation: task must not be empty");
    }

    const friendlyId = parameters.agent_id ?? this.generateFriendlyId(callerId);
    this.validateFriendlyId(friendlyId);
    const agentId = this.buildChildAgentId(callerId, friendlyId);
    if (this.tombstones.has(agentId)) {
      throw new Error(`Minimal subagents agent ID is tombstoned: ${agentId}`);
    }
    if (this.agents.has(agentId) || this.pendingAgentIds.has(agentId)) {
      throw new Error(`Minimal subagents duplicate agent ID: ${agentId}`);
    }

    const sessionContext = parameters.session_context ?? "inherit";
    const projectContext = parameters.project_context ?? "inherit";
    const model = parameters.model ?? caller.model;
    const requestedThinking = parameters.thinking_level ?? caller.thinkingLevel;
    const thinkingLevel = this.dependencies.sessions.resolveThinkingLevel(model, requestedThinking);
    const ordinaryTools = resolveOrdinaryToolSelection(parameters.tools, {
      ordinaryTools: excludeCoordinatorTools(caller.ordinaryTools),
      capabilityCeiling: excludeCoordinatorTools(caller.capabilityCeiling),
      availableTools: excludeCoordinatorTools(caller.availableTools),
    });
    const committedMessages = structuredClone(caller.messages);
    const imported = assembleImportedContext(sessionContext, committedMessages);
    if (
      contextContainsImages(imported.messages) &&
      !this.dependencies.sessions.modelSupportsImages(model)
    ) {
      throw new Error(
        `Minimal subagents spawn validation: model ${model} does not support image input`,
      );
    }

    const createdAt = this.now().toISOString();
    const agent: PersistedAgent = {
      agent_id: agentId,
      friendly_id: friendlyId,
      parent_id: callerId,
      created_at: createdAt,
      task: parameters.task,
      latest_activity_at: createdAt,
      spawn_entry_id: caller.spawnEntryId,
      launch_contract: {
        session_context: sessionContext,
        project_context: projectContext,
        model,
        thinking_level: thinkingLevel,
        tools: parameters.tools,
        ordinary_tools: ordinaryTools,
        delegation: parameters.delegation ?? "none",
      },
      capability_ceiling: [...ordinaryTools],
      availability: "available",
      missing_dependencies: [],
      recent_messages: [],
    };
    this.pendingAgentIds.add(agentId);
    let identity: ReturnType<AgentSessionFactory["createIdentity"]>;
    try {
      const missingDependencies =
        await this.dependencies.sessions.resolveLaunchMissingDependencies(agent);
      this.assertAccepting();
      if (missingDependencies.length > 0) {
        throw new Error(
          `Minimal subagents launch dependencies unavailable: ${missingDependencies.join(", ")}`,
        );
      }
      identity = this.dependencies.sessions.createIdentity(agent, imported.messages);
    } finally {
      this.pendingAgentIds.delete(agentId);
    }
    if (!identity.sessionLeafId) {
      throw new Error(
        `Minimal subagents persistent identity: no selected session leaf for ${agent.agent_id}`,
      );
    }
    agent.session_file = identity.sessionFile;
    agent.session_id = identity.sessionId;
    agent.session_leaf_id = identity.sessionLeafId;
    this.agents.set(agentId, agent);
    this.dependencies.registry.append(
      createRegistryEvent(this.dependencies.registry.rootSessionId, "agent-created", { agent }),
    );
    const turnId = this.beginTurn(agent);
    this.dependencies.notify?.({
      type: "spawn",
      agentId,
      message: `Spawned ${agentId}`,
    });

    this.trackBackgroundOperation(
      this.initializeAndRunPrompt(
        agentId,
        turnId,
        parameters.task,
        imported.compact,
        caller.model,
        caller.thinkingLevel,
      ),
    );
    return { agent_id: agentId, turn_id: turnId, status: "running" };
  }

  /** Capture immutable launch defaults for a nested caller from its active child runtime. */
  snapshotChildCaller(agentId: string, spawnEntryId: string): CallerSnapshot {
    const agent = this.requireAgent(agentId);
    const runtime = this.runtimes.get(agentId);
    return {
      messages: runtime?.snapshotCommittedMessages() ?? [],
      model: agent.launch_contract.model,
      thinkingLevel: agent.launch_contract.thinking_level,
      ordinaryTools: [...agent.launch_contract.ordinary_tools],
      capabilityCeiling: [...agent.capability_ceiling],
      availableTools: [...agent.capability_ceiling],
      spawnEntryId,
    };
  }

  /** Send one coordination message to an authorized adjacent agent. */
  async sendAgentMessage(
    callerId: string,
    parameters: MessageParameters,
    sourceTurnId: string,
  ): Promise<AgentMessageResult> {
    this.assertAccepting();
    this.assertCallerExists(callerId);
    const targetId = this.resolveMessageTarget(callerId, parameters.agent_id);
    const messageId = randomUUID();
    const message = this.createExplicitMessage(
      callerId,
      targetId,
      sourceTurnId,
      messageId,
      parameters.message,
    );
    const sourceAgent = callerId === "root" ? undefined : this.requireAgent(callerId);
    const sentToDirectParent = sourceAgent?.parent_id === targetId;
    const delivery = this.persistCoordinationDelivery(message, targetId);
    try {
      this.recordRecentMessage(targetId, message);
      if (sentToDirectParent) {
        if (this.resolveWaiterWithMessage(message, delivery)) {
          return { agent_id: targetId, message_id: messageId, disposition: "delivered-via-wait" };
        }
        this.queuePendingParentMessage(targetId, message, delivery);
        return { agent_id: targetId, message_id: messageId, disposition: "queued" };
      }
      const disposition = await this.enqueueRecipientDelivery(targetId, async () =>
        this.deliverExplicitMessage(message, targetId, delivery),
      );
      return { agent_id: targetId, message_id: messageId, disposition };
    } catch (error) {
      const deliveryError = error instanceof Error ? error.message : String(error);
      if (this.isCoordinationDeliveryCurrent(delivery)) {
        this.deliveryLedger = setCoordinationDeliveryError(
          this.deliveryLedger,
          delivery.delivery_id,
          deliveryError,
        );
        const current = findCoordinationDelivery(this.deliveryLedger, delivery.delivery_id);
        if (current) this.persistCoordinationDeliveryState(current);
      }
      return {
        agent_id: targetId,
        message_id: messageId,
        disposition: "failed",
        error: deliveryError,
      };
    }
  }

  /** Wait for one exact turn and claim its message/result delivery from automatic fallback. */
  wait(
    callerId: string,
    agentId: string,
    timeoutMs?: number,
    signal?: AbortSignal,
    requestedTurnId?: string,
  ): Promise<WaitResult> {
    this.assertAccepting();
    this.assertCallerExists(callerId);
    this.assertCallerTargetsDirectChild(callerId, agentId, "wait");
    const agent = this.requireUsableAgent(agentId, "wait");
    const turnId = requestedTurnId ?? this.selectObservableTurnId(agentId, callerId);
    if (!turnId) {
      return Promise.reject(new Error(`Minimal subagents wait: ${agentId} has no turn to observe`));
    }
    const key = agentDeliveryKey(agentId, turnId);
    if ([...(this.waiters.get(key) ?? [])].some((waiter) => waiter.callerId === callerId)) {
      return Promise.reject(
        new Error(`Minimal subagents duplicate wait: ${callerId} is already waiting for ${turnId}`),
      );
    }
    const retainedResult =
      findTerminalDelivery(this.deliveryLedger, agentId, turnId)?.result ??
      (agent.latest_result?.turn_id === turnId ? agent.latest_result : undefined);
    if (retainedResult) {
      const messages = this.drainPendingParentMessages(callerId, agentId, turnId);
      this.claimTerminalDelivery(callerId, retainedResult);
      return Promise.resolve(terminalWaitResult(retainedResult, messages));
    }
    const pendingMessage = this.claimPendingParentMessage(callerId, agentId, turnId);
    if (pendingMessage) return Promise.resolve(pendingMessage);
    if (agent.active_turn_id !== turnId) {
      return Promise.reject(
        new Error(`Minimal subagents wait: turn ${turnId} is no longer retained for ${agentId}`),
      );
    }

    return new Promise<WaitResult>((resolve, reject) => {
      const waiter: TurnWaiter = { callerId, resolve, reject, abortSignal: signal };
      let turnWaiters = this.waiters.get(key);
      if (!turnWaiters) {
        turnWaiters = new Set();
        this.waiters.set(key, turnWaiters);
      }
      turnWaiters.add(waiter);
      const stopWaiting = (error: Error) => {
        this.removeWaiter(key, waiter);
        reject(error);
      };
      if (timeoutMs !== undefined) {
        waiter.timeout = setTimeout(
          () =>
            stopWaiting(
              new Error(`Minimal subagents wait timed out for ${agentId} after ${timeoutMs}ms`),
            ),
          timeoutMs,
        );
      }
      if (signal) {
        waiter.abortListener = () =>
          stopWaiting(new Error(`Minimal subagents wait cancelled for ${agentId}`));
        if (signal.aborted) waiter.abortListener();
        else signal.addEventListener("abort", waiter.abortListener, { once: true });
      }
    });
  }

  /** Return direct-child status authorized for one root or child caller. */
  status(callerId: string, agentId?: string): StatusResult {
    this.assertCallerExists(callerId);
    if (agentId !== undefined) {
      this.assertCallerTargetsDirectChild(callerId, agentId, "status");
      return { agent: this.buildAgentDetail(this.requireAgent(agentId), false) };
    }
    return {
      parent_id: callerId,
      agents: this.childrenOf(callerId).map((agent) => this.buildAgentSummary(agent, false)),
    };
  }

  /** Return the complete root hierarchy for trusted UI and coordinator activity projections. */
  inspectStatus(agentId?: string): HierarchyStatusResult {
    if (agentId !== undefined) return { agent: this.buildAgentDetail(this.requireAgent(agentId)) };
    return {
      root_id: "root",
      agents: this.childrenOf("root").map((agent) => this.buildAgentSummary(agent)),
    };
  }

  /** Report whether root or one explicitly authorized child can create another agent. */
  canAgentSpawn(callerId: string): boolean {
    if (callerId === "root") return true;
    const caller = this.agents.get(callerId);
    return caller
      ? canAgentContractSpawn(
          caller.agent_id,
          caller.launch_contract.delegation,
          this.maxSubagentDepth,
        )
      : false;
  }

  /** Abort one caller-owned direct child turn, optionally including its subtree. */
  async cancel(callerId: string, agentId: string, recursive = true): Promise<CancelResult> {
    this.assertAccepting();
    this.assertCallerCanManageAgent(callerId, agentId, "cancel");
    const target = this.requireUsableAgent(agentId, "cancel");
    const affected = recursive ? [target, ...this.descendantsOf(agentId)] : [target];
    const cancelledTurnIds: string[] = [];
    for (const agent of affected) {
      const cancelledTurnId = await this.cancelActiveTurn(agent);
      if (cancelledTurnId) cancelledTurnIds.push(cancelledTurnId);
    }
    return {
      agent_id: agentId,
      recursive,
      affected_agent_ids: affected.map((agent) => agent.agent_id),
      cancelled_turn_ids: cancelledTurnIds,
    };
  }

  /** Delete one caller-owned direct child session, optionally including its subtree post-order. */
  async delete(callerId: string, agentId: string, recursive = true): Promise<DeleteResult> {
    this.assertAccepting();
    this.assertCallerCanManageAgent(callerId, agentId, "delete");
    const target = this.requireAgent(agentId);
    const descendants = this.descendantsOf(agentId);
    if (!recursive && descendants.length > 0) {
      throw new Error(
        `Minimal subagents delete: ${agentId} has descendants; use recursive deletion`,
      );
    }
    const ordered = recursive ? [...descendants].reverse().concat(target) : [target];
    const result: DeleteResult = {
      agent_id: agentId,
      recursive,
      deleted_agent_ids: [],
      tombstoned_agent_ids: [],
      trashed_session_files: [],
      failures: [],
    };
    const failedAncestors = new Set<string>();

    for (const agent of ordered) {
      if (
        [...failedAncestors].some(
          (failedId) => agent.agent_id === failedId || failedId.startsWith(`${agent.agent_id}.`),
        )
      ) {
        continue;
      }
      const runtime = this.runtimes.get(agent.agent_id);
      try {
        if (agent.active_turn_id) await this.cancelActiveTurn(agent);
        runtime?.dispose();
        this.runtimes.delete(agent.agent_id);
        if (agent.session_file) {
          await this.dependencies.sessions.trashSession(agent);
          result.trashed_session_files.push(agent.session_file);
        }
        this.agents.delete(agent.agent_id);
        this.pruneDeliveryStateForDeletedAgent(agent.agent_id);
        this.pruneRecentMessageProjectionsForDeletedAgent(agent.agent_id);
        this.tombstones.add(agent.agent_id);
        result.deleted_agent_ids.push(agent.agent_id);
        result.tombstoned_agent_ids.push(agent.agent_id);
        this.dependencies.registry.append(
          createRegistryEvent(this.dependencies.registry.rootSessionId, "agent-deleted", {
            agent_ids: [agent.agent_id],
          }),
        );
      } catch (error) {
        failedAncestors.add(agent.agent_id);
        if (runtime && agent.session_file) {
          try {
            this.runtimes.set(agent.agent_id, await this.dependencies.sessions.openRuntime(agent));
          } catch (restoreError) {
            agent.availability = "unavailable";
            agent.unavailable_reason = `Deletion recovery failed: ${
              restoreError instanceof Error ? restoreError.message : String(restoreError)
            }`;
          }
        }
        result.failures.push({
          agent_id: agent.agent_id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return result;
  }

  /** Restore non-deleted descendants, interrupt unfinished work, and reconcile pending successful output. */
  async restore(snapshot: RegistrySnapshot): Promise<void> {
    const restoreEpoch = ++this.lifecycleEpoch;
    this.rejectAllWaiters(
      new Error("Minimal subagents wait cancelled because the session branch changed"),
    );
    const abandonedRuntimes = [...this.runtimes.values()];
    this.agents.clear();
    this.deliveryLedger = createDeliveryLedger();
    this.pendingParentMessages.clear();
    this.recipientQueues.clear();
    this.backgroundOperations.clear();
    await Promise.allSettled(
      abandonedRuntimes.map((runtime) => (runtime.isRunning ? runtime.abort() : Promise.resolve())),
    );
    for (const runtime of abandonedRuntimes) runtime.dispose();
    this.runtimes.clear();
    this.runtimeInitializations.clear();
    this.pendingAgentIds.clear();
    this.tombstones.clear();
    this.deliveryLedger = createDeliveryLedger();
    this.waiters.clear();
    this.pendingParentMessages.clear();
    this.waitHandedDeliveryIds.clear();
    this.recipientQueues.clear();
    this.backgroundOperations.clear();
    this.automaticDeliveryKeys.clear();
    this.automaticCoordinationDeliveryIds.clear();
    this.deliveryLedger = createDeliveryLedger({
      deliveries: snapshot.deliveries,
      coordination_deliveries: snapshot.coordination_deliveries,
      wait_claimed_turns: snapshot.wait_claimed_turns,
      next_delivery_sequence: snapshot.next_delivery_sequence,
    });
    this.acceptingOperations = true;
    this.shutdownPromise = undefined;

    for (const agent of snapshot.agents) this.agents.set(agent.agent_id, structuredClone(agent));
    for (const tombstone of snapshot.tombstones) this.tombstones.add(tombstone);

    for (const agent of this.agents.values()) {
      if (agent.active_turn_id) {
        const interrupted: TurnResult = {
          agent_id: agent.agent_id,
          turn_id: agent.active_turn_id,
          status: "interrupted",
          output: "",
          error: "Turn interrupted because the owning Pi process exited",
        };
        this.settleTurn(agent, agent.active_turn_id, interrupted);
        this.dependencies.notify?.({
          type: "interruption",
          agentId: agent.agent_id,
          message: `Restored ${agent.agent_id} with an interrupted turn`,
        });
      }
      const previousAvailability = agent.availability;
      try {
        const missing = agent.clone_error
          ? [agent.clone_error]
          : await this.dependencies.sessions.resolveRestorationMissingDependencies(agent);
        if (restoreEpoch !== this.lifecycleEpoch) return;
        if (missing.length > 0 || !agent.session_file) {
          agent.availability = "unavailable";
          if (previousAvailability !== "unavailable")
            agent.latest_activity_at = this.now().toISOString();
          agent.missing_dependencies = missing.length > 0 ? missing : agent.missing_dependencies;
          agent.unavailable_reason =
            agent.clone_error ??
            (missing.length > 0
              ? `Missing dependencies: ${missing.join(", ")}`
              : (agent.unavailable_reason ?? `No persistent session exists for ${agent.agent_id}`));
          this.dependencies.notify?.({
            type: "unavailable",
            agentId: agent.agent_id,
            message: `${agent.agent_id} unavailable: ${agent.unavailable_reason}`,
          });
          continue;
        }
        const runtime = await this.dependencies.sessions.openRuntime(agent);
        if (restoreEpoch !== this.lifecycleEpoch) {
          runtime.dispose();
          return;
        }
        if (!runtime.sessionLeafId) {
          runtime.dispose();
          throw new Error(
            `Minimal subagents session restoration: no selected session leaf for ${agent.agent_id}`,
          );
        }
        this.runtimes.set(agent.agent_id, runtime);
        agent.session_leaf_id = runtime.sessionLeafId;
        agent.availability = "available";
        if (previousAvailability !== "available")
          agent.latest_activity_at = this.now().toISOString();
        agent.missing_dependencies = [];
        agent.unavailable_reason = undefined;
        this.dependencies.notify?.({
          type: "restoration",
          agentId: agent.agent_id,
          message: `Restored ${agent.agent_id}`,
        });
      } catch (error) {
        if (restoreEpoch !== this.lifecycleEpoch) return;
        agent.availability = "unavailable";
        if (previousAvailability !== "unavailable")
          agent.latest_activity_at = this.now().toISOString();
        agent.unavailable_reason = error instanceof Error ? error.message : String(error);
        this.dependencies.notify?.({
          type: "unavailable",
          agentId: agent.agent_id,
          message: `${agent.agent_id} unavailable: ${agent.unavailable_reason}`,
        });
      }
    }
    if (restoreEpoch === this.lifecycleEpoch) await this.reconcileDeliveries(true);
  }

  /** Schedule delivery reconciliation as coordinator-owned work drained during shutdown. */
  scheduleDeliveryReconciliation(replayMissing = false): void {
    this.trackBackgroundOperation(this.reconcileDeliveries(replayMissing));
  }

  /** Reconcile durable destination evidence and replay only successful undelivered output. */
  async reconcileDeliveries(replayMissing = false): Promise<void> {
    const pendingItems = [
      ...this.deliveryLedger.coordinationDeliveries.map((delivery) => ({
        kind: "coordination" as const,
        sequence: delivery.sequence,
        delivery,
      })),
      ...this.deliveryLedger.terminalDeliveries.map((delivery) => ({
        kind: "terminal" as const,
        sequence: delivery.sequence ?? Number.MAX_SAFE_INTEGER,
        delivery,
      })),
    ].sort((left, right) => left.sequence - right.sequence);
    const scheduled: Promise<void>[] = [];

    for (const item of pendingItems) {
      if (item.kind === "coordination") {
        const delivery = item.delivery;
        if (this.hasCoordinationDeliveryEvidence(delivery)) {
          this.settleCoordinationDelivery(delivery);
          continue;
        }
        if (!replayMissing || delivery.path === "wait") continue;
        const source = this.agents.get(delivery.message.details.source_agent_id);
        if (source?.parent_id === delivery.destination_agent_id) {
          const key = agentDeliveryKey(
            delivery.message.details.source_agent_id,
            delivery.message.details.source_turn_id,
          );
          const alreadyQueued = this.pendingParentMessages
            .get(key)
            ?.some((pending) => pending.deliveryId === delivery.delivery_id);
          if (!alreadyQueued && !this.waitHandedDeliveryIds.has(delivery.delivery_id)) {
            this.queuePendingParentMessage(
              delivery.destination_agent_id,
              delivery.message,
              delivery,
            );
          }
        } else {
          scheduled.push(this.replayCoordinationDelivery(delivery));
        }
        continue;
      }

      const delivery = item.delivery;
      const agent = this.agents.get(delivery.source_agent_id);
      const result = delivery.result ?? agent?.latest_result;
      if (!result || result.status !== "completed" || result.turn_id !== delivery.source_turn_id)
        continue;
      if (this.hasDeliveryEvidence(delivery)) {
        this.settleDelivery(delivery);
        continue;
      }
      if (!replayMissing || delivery.path === "wait") continue;
      scheduled.push(this.deliverAutomaticResult(result, delivery));
    }
    await Promise.allSettled(scheduled);
  }

  /** Clone complete child leaves for root fork ownership without ever sharing source session paths. */
  async prepareFork(sourceRootSessionFile: string): Promise<ForkSnapshot> {
    const activeRootChildren = this.childrenOf("root");
    for (const child of activeRootChildren) await this.cancelDuringShutdown(child.agent_id);
    await this.waitForSettledOperations();
    const forkAgents: PersistedAgent[] = [];
    const failedSubtrees = new Set<string>();

    for (const agent of this.agents.values()) {
      const failedAncestor = [...failedSubtrees].find(
        (failedId) => agent.agent_id === failedId || agent.agent_id.startsWith(`${failedId}.`),
      );
      if (failedAncestor) {
        forkAgents.push(
          this.createForkPlaceholder(agent, `Ancestor clone failed: ${failedAncestor}`),
        );
        continue;
      }
      try {
        const clone = await this.dependencies.sessions.cloneSession(agent);
        if (!clone.sessionLeafId) {
          throw new Error(
            `Minimal subagents fork clone: no selected session leaf for ${agent.agent_id}`,
          );
        }
        forkAgents.push({
          ...structuredClone(agent),
          session_file: clone.sessionFile,
          session_id: clone.sessionId,
          session_leaf_id: clone.sessionLeafId,
          active_turn_id: undefined,
          active_turn_started_at: undefined,
        });
      } catch (error) {
        const cloneError = error instanceof Error ? error.message : String(error);
        failedSubtrees.add(agent.agent_id);
        forkAgents.push(this.createForkPlaceholder(agent, cloneError));
        this.dependencies.notify?.({
          type: "fork-clone-failure",
          agentId: agent.agent_id,
          message: `Fork clone failed for ${agent.agent_id}: ${cloneError}`,
        });
      }
    }

    const snapshot = this.snapshot();
    return {
      ...snapshot,
      source_root_session_file: sourceRootSessionFile,
      source_root_session_id: this.dependencies.registry.rootSessionId,
      agents: forkAgents,
    };
  }

  /** Stop new operations and idempotently cancel and dispose every child runtime. */
  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.acceptingOperations = false;
    this.shutdownPromise = this.finishShutdown();
    return this.shutdownPromise;
  }

  /** Let dynamic coordinator work settle before stopping acceptance and disposing child runtimes. */
  shutdownAfterSettling(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    if (!this.hasPendingOperations()) {
      this.acceptingOperations = false;
      this.shutdownPromise = this.finishShutdown();
      return this.shutdownPromise;
    }
    this.shutdownPromise = (async () => {
      await this.waitForSettledOperations();
      this.acceptingOperations = false;
      await this.finishShutdown();
    })();
    return this.shutdownPromise;
  }

  /** Wait until active turns, initialization, delivery, and recipient queues are all settled. */
  async waitForSettledOperations(): Promise<void> {
    while (this.hasPendingOperations()) {
      const pending = [
        ...this.runtimeInitializations.values(),
        ...this.backgroundOperations,
        ...this.recipientQueues.values(),
      ];
      if (pending.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        continue;
      }
      await Promise.race(
        pending.map((operation) =>
          operation.then(
            () => undefined,
            () => undefined,
          ),
        ),
      );
    }
  }

  private hasPendingOperations(): boolean {
    return (
      [...this.agents.values()].some((agent) => agent.active_turn_id !== undefined) ||
      this.runtimeInitializations.size > 0 ||
      this.backgroundOperations.size > 0 ||
      this.recipientQueues.size > 0
    );
  }

  private async finishShutdown(): Promise<void> {
    const roots = this.childrenOf("root");
    for (const child of roots) {
      if (this.agents.has(child.agent_id)) await this.cancelDuringShutdown(child.agent_id);
    }
    await Promise.allSettled(this.runtimeInitializations.values());
    await Promise.allSettled(this.backgroundOperations);
    await Promise.allSettled(this.recipientQueues.values());
    for (const runtime of this.runtimes.values()) runtime.dispose();
    this.runtimes.clear();
  }

  private async initializeAndRunPrompt(
    agentId: string,
    turnId: string,
    task: string,
    compact: boolean,
    callerModel: string,
    callerThinkingLevel: CallerSnapshot["thinkingLevel"],
  ): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    try {
      const runtime = await this.ensureRuntime(agent);
      if (this.agents.get(agentId) !== agent || agent.active_turn_id !== turnId) {
        if (!this.agents.has(agentId) || !this.acceptingOperations) {
          runtime.dispose();
          this.runtimes.delete(agentId);
        }
        return;
      }
      const outcome = await runtime.runPrompt(task, compact, callerModel, callerThinkingLevel);
      if (this.agents.get(agentId) !== agent || agent.active_turn_id !== turnId) return;
      this.settleTurn(agent, turnId, terminalTurnResult(agentId, turnId, outcome));
    } catch (error) {
      if (this.agents.get(agentId) !== agent || agent.active_turn_id !== turnId) return;
      this.settleTurn(agent, turnId, {
        agent_id: agentId,
        turn_id: turnId,
        status: "failed",
        output: "",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private ensureRuntime(agent: PersistedAgent): Promise<ChildAgentRuntime> {
    const current = this.runtimes.get(agent.agent_id);
    if (current) return Promise.resolve(current);
    const initializing = this.runtimeInitializations.get(agent.agent_id);
    if (initializing) return initializing;
    if (agent.clone_error || !agent.session_file || !agent.session_id) {
      return Promise.reject(
        new Error(agent.clone_error ?? `No persistent session exists for ${agent.agent_id}`),
      );
    }
    const initialization = this.dependencies.sessions
      .openRuntime(agent)
      .then((runtime) => {
        if (this.agents.get(agent.agent_id) !== agent) {
          runtime.dispose();
          throw new Error(`Minimal subagents runtime replaced while opening ${agent.agent_id}`);
        }
        this.runtimes.set(agent.agent_id, runtime);
        return runtime;
      })
      .finally(() => {
        if (this.runtimeInitializations.get(agent.agent_id) === initialization) {
          this.runtimeInitializations.delete(agent.agent_id);
        }
      });
    this.runtimeInitializations.set(agent.agent_id, initialization);
    return initialization;
  }

  private beginTurn(agent: PersistedAgent): TurnId {
    // SAFETY: The generated value embeds the canonical agent ID and a fresh turn UUID before branding.
    const turnId = `${agent.agent_id}:turn-${randomUUID()}` as TurnId;
    const startedAt = this.now().toISOString();
    agent.active_turn_id = turnId;
    agent.active_turn_started_at = startedAt;
    agent.latest_activity_at = startedAt;
    this.dependencies.registry.append(
      createRegistryEvent(this.dependencies.registry.rootSessionId, "turn-started", {
        agent_id: agent.agent_id,
        turn_id: turnId,
        started_at: startedAt,
      }),
    );
    return turnId;
  }

  private settleTurn(agent: PersistedAgent, turnId: string, result: TurnResult): void {
    if (agent.active_turn_id !== turnId) return;
    const settledAt = this.now();
    const startedAt = agent.active_turn_started_at
      ? new Date(agent.active_turn_started_at).getTime()
      : Number.NaN;
    result = {
      ...result,
      elapsed_ms:
        result.elapsed_ms ??
        (Number.isFinite(startedAt) ? Math.max(0, settledAt.getTime() - startedAt) : undefined),
    };
    agent.active_turn_id = undefined;
    agent.active_turn_started_at = undefined;
    agent.latest_activity_at = settledAt.toISOString();
    agent.latest_result = structuredClone(result);
    const runtimeLeafId = this.runtimes.get(agent.agent_id)?.sessionLeafId;
    if (runtimeLeafId) agent.session_leaf_id = runtimeLeafId;
    this.dependencies.registry.append(
      createRegistryEvent(this.dependencies.registry.rootSessionId, "turn-settled", {
        result,
        settled_at: settledAt.toISOString(),
        session_leaf_id: runtimeLeafId,
      }),
    );
    const waiterKey = agentDeliveryKey(agent.agent_id, turnId);
    const turnWaiters = this.waiters.get(waiterKey);
    const directParentWaited = [...(turnWaiters ?? [])].some(
      (waiter) => waiter.callerId === agent.parent_id,
    );
    if (directParentWaited && result.status === "completed") {
      this.claimDeliveryTurn(agent.agent_id, turnId);
    }
    const parentClaimedTurn =
      directParentWaited ||
      isDeliveryLedgerTurnClaimed(this.deliveryLedger, agent.agent_id, turnId);
    for (const waiter of turnWaiters ?? []) {
      this.removeWaiter(waiterKey, waiter);
      waiter.resolve(terminalWaitResult(result));
    }
    if (result.status === "completed") {
      const added = addTerminalDelivery(this.deliveryLedger, {
        destinationAgentId: agent.parent_id,
        path: parentClaimedTurn ? "wait" : "message",
        result,
      });
      this.applyDeliveryLedgerTransition(added);
      const delivery = added.delivery;
      this.dependencies.registry.append(
        createRegistryEvent(this.dependencies.registry.rootSessionId, "delivery-pending", {
          delivery,
        }),
      );
      if (!parentClaimedTurn) {
        this.trackBackgroundOperation(this.deliverAutomaticResult(result, delivery));
      }
      this.dependencies.notify?.({
        type: "completion",
        agentId: agent.agent_id,
        message: `${agent.agent_id} completed`,
      });
    } else if (result.status === "failed") {
      this.dependencies.notify?.({
        type: "failure",
        agentId: agent.agent_id,
        message: `${agent.agent_id} failed: ${result.error ?? "unknown error"}`,
      });
    }
    if (result.status !== "completed") this.removeSettledEmptyTurnClaim(agent.agent_id, turnId);
  }

  private async deliverAutomaticResult(
    result: TurnResult,
    delivery: PersistedDelivery,
  ): Promise<void> {
    const deliveryKey = agentDeliveryKey(delivery.source_agent_id, delivery.source_turn_id);
    if (this.automaticDeliveryKeys.has(deliveryKey)) return;
    this.automaticDeliveryKeys.add(deliveryKey);
    const graceMs = this.deliveryGraceMs();
    try {
      await this.enqueueRecipientDelivery(delivery.destination_agent_id, async () => {
        if (delivery.destination_agent_id !== "root") {
          await this.ensureRuntime(
            this.requireUsableAgent(delivery.destination_agent_id, "message"),
          );
          if (!this.isTerminalDeliveryCurrent(delivery)) return;
        }
        if (graceMs > 0) await new Promise((resolve) => setTimeout(resolve, graceMs));
        if (!this.acceptingOperations || this.shouldStopAutomaticTerminalDelivery(delivery)) return;
        if (this.hasDeliveryEvidence(delivery)) {
          this.settleDelivery(delivery);
          return;
        }
        if (!this.acceptingOperations || this.shouldStopAutomaticTerminalDelivery(delivery)) return;
        if (this.hasDeliveryEvidence(delivery)) {
          this.settleDelivery(delivery);
          return;
        }
        const message: CoordinatorMessage = {
          customType: "minimal-subagents.result",
          content: result.output,
          details: {
            source_agent_id: delivery.source_agent_id,
            destination_agent_id: delivery.destination_agent_id,
            source_turn_id: result.turn_id,
            message_id: `result:${delivery.source_agent_id}:${result.turn_id}`,
            status: result.status,
            elapsed_ms: result.elapsed_ms,
            usage: result.usage,
          },
        };
        await this.deliverToRecipient(delivery.destination_agent_id, message, () =>
          this.isTerminalDeliveryCurrent(delivery),
        );
      });
    } catch (error) {
      if (!this.isTerminalDeliveryCurrent(delivery)) return;
      const deliveryError = error instanceof Error ? error.message : String(error);
      this.deliveryLedger = setTerminalDeliveryError(
        this.deliveryLedger,
        delivery.source_agent_id,
        delivery.source_turn_id,
        deliveryError,
      );
      this.dependencies.registry.append(
        createRegistryEvent(this.dependencies.registry.rootSessionId, "delivery-settled", {
          source_agent_id: delivery.source_agent_id,
          source_turn_id: delivery.source_turn_id,
          error: deliveryError,
        }),
      );
    } finally {
      this.automaticDeliveryKeys.delete(deliveryKey);
    }
  }

  private persistCoordinationDelivery(
    message: CoordinatorMessage,
    destinationAgentId: string,
  ): PersistedCoordinationDelivery {
    const added = addCoordinationDelivery(this.deliveryLedger, {
      destinationAgentId,
      message,
    });
    this.deliveryLedger = added.ledger;
    message.details.delivery_id = added.delivery.delivery_id;
    this.persistCoordinationDeliveryState(added.delivery);
    return added.delivery;
  }

  private persistCoordinationDeliveryState(delivery: PersistedCoordinationDelivery): void {
    this.dependencies.registry.append(
      createRegistryEvent(
        this.dependencies.registry.rootSessionId,
        "coordination-delivery-pending",
        { delivery },
      ),
    );
  }

  private settleCoordinationDelivery(delivery: PersistedCoordinationDelivery): void {
    this.deliveryLedger = settleCoordinationDelivery(
      this.deliveryLedger,
      delivery.delivery_id,
    ).ledger;
    this.waitHandedDeliveryIds.delete(delivery.delivery_id);
    this.dependencies.registry.append(
      createRegistryEvent(
        this.dependencies.registry.rootSessionId,
        "coordination-delivery-settled",
        { delivery_id: delivery.delivery_id },
      ),
    );
    this.removeSettledEmptyTurnClaim(
      delivery.message.details.source_agent_id,
      delivery.message.details.source_turn_id,
    );
  }

  private removeSettledEmptyTurnClaim(sourceAgentId: string, sourceTurnId: string): void {
    const transition = releaseEmptyDeliveryLedgerTurn(
      this.deliveryLedger,
      sourceAgentId,
      sourceTurnId,
      this.agents.get(sourceAgentId)?.active_turn_id === sourceTurnId,
    );
    this.deliveryLedger = transition.ledger;
    if (transition.changed) {
      this.dependencies.registry.append(
        createRegistryEvent(this.dependencies.registry.rootSessionId, "delivery-turn-released", {
          source_agent_id: sourceAgentId,
          source_turn_id: sourceTurnId,
        }),
      );
    }
  }

  private claimDeliveryTurn(sourceAgentId: string, sourceTurnId: string): void {
    const transition = claimDeliveryLedgerTurn(this.deliveryLedger, sourceAgentId, sourceTurnId);
    this.deliveryLedger = transition.ledger;
    if (!transition.changed) return;
    this.dependencies.registry.append(
      createRegistryEvent(this.dependencies.registry.rootSessionId, "delivery-turn-claimed", {
        source_agent_id: sourceAgentId,
        source_turn_id: sourceTurnId,
      }),
    );
  }

  private selectObservableTurnId(
    sourceAgentId: string,
    destinationAgentId: string,
  ): string | undefined {
    const agent = this.agents.get(sourceAgentId);
    return selectObservableDeliveryTurn(this.deliveryLedger, {
      sourceAgentId,
      destinationAgentId,
      waitHandedDeliveryIds: this.waitHandedDeliveryIds,
      activeTurnId: agent?.active_turn_id,
      latestResultTurnId: agent?.latest_result?.turn_id,
    });
  }

  private createExplicitMessage(
    callerId: string,
    targetId: string,
    sourceTurnId: string,
    messageId: string,
    content: string,
  ): CoordinatorMessage {
    return {
      customType: "minimal-subagents.message",
      content,
      details: {
        source_agent_id: callerId,
        destination_agent_id: targetId,
        source_turn_id: sourceTurnId,
        message_id: messageId,
      },
    };
  }

  private recordRecentMessage(targetId: string, message: CoordinatorMessage): void {
    if (targetId !== "root") {
      const target = this.requireUsableAgent(targetId, "message");
      const recentMessage = {
        source_agent_id: message.details.source_agent_id,
        turn_id: message.details.source_turn_id,
        content: message.content,
      };
      target.recent_messages.push(recentMessage);
      if (target.recent_messages.length > RECENT_MESSAGE_LIMIT) target.recent_messages.shift();
      const recordedAt = this.now().toISOString();
      target.latest_activity_at = recordedAt;
      this.dependencies.registry.append(
        createRegistryEvent(
          this.dependencies.registry.rootSessionId,
          "agent-message-recorded",
          {
            agent_id: target.agent_id,
            message: recentMessage,
            recorded_at: recordedAt,
          },
          recordedAt,
        ),
      );
    }
  }

  private async replayCoordinationDelivery(delivery: PersistedCoordinationDelivery): Promise<void> {
    if (this.automaticCoordinationDeliveryIds.has(delivery.delivery_id)) return;
    this.automaticCoordinationDeliveryIds.add(delivery.delivery_id);
    try {
      await this.enqueueRecipientDelivery(delivery.destination_agent_id, async () => {
        if (this.hasCoordinationDeliveryEvidence(delivery)) {
          this.settleCoordinationDelivery(delivery);
          return;
        }
        this.waitHandedDeliveryIds.add(delivery.delivery_id);
        await this.deliverToRecipient(delivery.destination_agent_id, delivery.message, () =>
          this.isCoordinationDeliveryCurrent(delivery),
        );
      });
    } catch (error) {
      this.waitHandedDeliveryIds.delete(delivery.delivery_id);
      if (!this.isCoordinationDeliveryCurrent(delivery)) return;
      const deliveryError = error instanceof Error ? error.message : String(error);
      this.deliveryLedger = setCoordinationDeliveryError(
        this.deliveryLedger,
        delivery.delivery_id,
        deliveryError,
      );
      const current = findCoordinationDelivery(this.deliveryLedger, delivery.delivery_id);
      if (current) this.persistCoordinationDeliveryState(current);
    } finally {
      this.automaticCoordinationDeliveryIds.delete(delivery.delivery_id);
    }
  }

  private async deliverExplicitMessage(
    message: CoordinatorMessage,
    targetId: string,
    delivery: PersistedCoordinationDelivery,
  ): Promise<AgentMessageDisposition> {
    this.waitHandedDeliveryIds.add(delivery.delivery_id);
    try {
      await this.deliverToRecipient(targetId, message, () =>
        this.isCoordinationDeliveryCurrent(delivery),
      );
      return "queued";
    } catch (error) {
      this.waitHandedDeliveryIds.delete(delivery.delivery_id);
      throw error;
    }
  }

  private async deliverToRecipient(
    targetId: string,
    message: CoordinatorMessage,
    isCurrentDelivery: () => boolean = () => true,
  ): Promise<void> {
    if (!isCurrentDelivery()) {
      throw new Error("Minimal subagents delivery abandoned after session branch change");
    }
    if (!this.acceptingOperations) {
      throw new Error("Minimal subagents delivery stopped during coordinator shutdown");
    }
    if (targetId === "root") {
      await this.dependencies.root.queueCoordinatorMessage(addCoordinatorMessageEnvelope(message));
      return;
    }
    const target = this.requireUsableAgent(targetId, "message");
    const runtime = this.runtimes.get(targetId) ?? (await this.ensureRuntime(target));
    if (!isCurrentDelivery()) {
      throw new Error("Minimal subagents delivery abandoned after session branch change");
    }
    const visibleMessage = addCoordinatorMessageEnvelope(message);
    if (target.active_turn_id || runtime.isRunning) {
      await runtime.queueCoordinatorMessage(visibleMessage);
      return;
    }
    const turnId = this.beginTurn(target);
    const runMessage = runtime
      .runMessage(visibleMessage)
      .then((outcome) => {
        if (this.agents.get(target.agent_id) === target && target.active_turn_id === turnId) {
          this.settleTurn(target, turnId, terminalTurnResult(target.agent_id, turnId, outcome));
        }
      })
      .catch((cause) => {
        if (this.agents.get(target.agent_id) === target && target.active_turn_id === turnId) {
          this.settleTurn(target, turnId, {
            agent_id: target.agent_id,
            turn_id: turnId,
            status: "failed",
            output: "",
            error: cause instanceof Error ? cause.message : String(cause),
          });
        }
      });
    this.trackBackgroundOperation(runMessage);
  }

  private trackBackgroundOperation(operation: Promise<void>): void {
    this.backgroundOperations.add(operation);
    const cleanup = () => this.backgroundOperations.delete(operation);
    void operation.then(cleanup, cleanup);
  }

  private enqueueRecipientDelivery<T>(targetId: string, operation: () => Promise<T>): Promise<T> {
    const epoch = this.lifecycleEpoch;
    const previous = this.recipientQueues.get(targetId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => {
        if (epoch !== this.lifecycleEpoch) {
          throw new Error("Minimal subagents delivery abandoned after session branch change");
        }
        return operation();
      });
    this.recipientQueues.set(targetId, next);
    const cleanup = () => {
      if (this.recipientQueues.get(targetId) === next) this.recipientQueues.delete(targetId);
    };
    void next.then(cleanup, cleanup);
    return next;
  }

  private buildChildAgentId(parentId: string, friendlyId: string): string {
    if (parentId !== "root") return `${parentId}.${friendlyId}`;
    const usesLegacyRootPrefix =
      [...this.agents.values()].some(
        (agent) => agent.parent_id === "root" && agent.agent_id.startsWith("root."),
      ) || [...this.tombstones].some((agentId) => agentId.startsWith("root."));
    return usesLegacyRootPrefix ? `root.${friendlyId}` : friendlyId;
  }

  private resolveMessageTarget(callerId: string, target?: string): string {
    const resolved = target ?? (callerId === "root" ? undefined : "parent");
    if (!resolved) throw new Error("Minimal subagents message: root caller must specify agent_id");
    if (resolved === "*") throw new Error('Minimal subagents message target "*" is unsupported');
    const caller = callerId === "root" ? undefined : this.requireAgent(callerId);
    const targetId = resolved === "parent" ? caller?.parent_id : resolved;
    if (!targetId) throw new Error("Minimal subagents message: root has no parent");
    const targetAgent = targetId === "root" ? undefined : this.requireAgent(targetId);
    const isDirectParent = caller?.parent_id === targetId;
    const isDirectSibling =
      caller !== undefined && targetAgent?.parent_id === caller.parent_id && targetId !== callerId;
    const isDirectChild = targetAgent?.parent_id === callerId;
    if (!isDirectParent && !isDirectSibling && !isDirectChild) {
      throw new Error(
        `Minimal subagents message authorization denied: ${callerId} cannot message ${targetId}`,
      );
    }
    return targetId;
  }

  private applyDeliveryLedgerTransition(transition: DeliveryLedgerTransition): void {
    this.deliveryLedger = transition.ledger;
    for (const delivery of transition.prunedTerminalDeliveries) {
      this.dependencies.registry.append(
        createRegistryEvent(this.dependencies.registry.rootSessionId, "delivery-pruned", {
          source_agent_id: delivery.source_agent_id,
          source_turn_id: delivery.source_turn_id,
          reason: "retention-limit",
        }),
      );
    }
  }

  private isTerminalDeliveryCurrent(delivery: PersistedDelivery): boolean {
    const current = findTerminalDelivery(
      this.deliveryLedger,
      delivery.source_agent_id,
      delivery.source_turn_id,
    );
    return current?.sequence === delivery.sequence;
  }

  private shouldStopAutomaticTerminalDelivery(delivery: PersistedDelivery): boolean {
    const current = findTerminalDelivery(
      this.deliveryLedger,
      delivery.source_agent_id,
      delivery.source_turn_id,
    );
    return current === undefined || current.path === "wait";
  }

  private isCoordinationDeliveryCurrent(delivery: PersistedCoordinationDelivery): boolean {
    return (
      findCoordinationDelivery(this.deliveryLedger, delivery.delivery_id)?.sequence ===
      delivery.sequence
    );
  }

  private hasDeliveryEvidence(delivery: PersistedDelivery): boolean {
    if (delivery.destination_agent_id === "root") {
      return this.dependencies.root.hasDeliveryEvidence(
        delivery.source_agent_id,
        delivery.source_turn_id,
      );
    }
    return (
      this.runtimes
        .get(delivery.destination_agent_id)
        ?.hasDeliveryEvidence(delivery.source_agent_id, delivery.source_turn_id) ?? false
    );
  }

  private hasCoordinationDeliveryEvidence(delivery: PersistedCoordinationDelivery): boolean {
    const sourceAgentId = delivery.message.details.source_agent_id;
    const sourceTurnId = delivery.message.details.source_turn_id;
    if (delivery.destination_agent_id === "root") {
      return this.dependencies.root.hasDeliveryEvidence(
        sourceAgentId,
        sourceTurnId,
        delivery.delivery_id,
      );
    }
    return (
      this.runtimes
        .get(delivery.destination_agent_id)
        ?.hasDeliveryEvidence(sourceAgentId, sourceTurnId, delivery.delivery_id) ?? false
    );
  }

  private settleDelivery(delivery: PersistedDelivery): void {
    this.deliveryLedger = settleTerminalDelivery(
      this.deliveryLedger,
      delivery.source_agent_id,
      delivery.source_turn_id,
    ).ledger;
    this.dependencies.registry.append(
      createRegistryEvent(this.dependencies.registry.rootSessionId, "delivery-settled", {
        source_agent_id: delivery.source_agent_id,
        source_turn_id: delivery.source_turn_id,
      }),
    );
    this.removeSettledEmptyTurnClaim(delivery.source_agent_id, delivery.source_turn_id);
  }

  private buildAgentSummary(agent: PersistedAgent, includeDescendants = true): AgentSummary {
    const directChildren = this.childrenOf(agent.agent_id);
    const children = includeDescendants
      ? directChildren.map((child) => this.buildAgentSummary(child))
      : [];
    const elapsed = agent.active_turn_started_at
      ? Math.max(0, this.now().getTime() - new Date(agent.active_turn_started_at).getTime())
      : undefined;
    const runtimeProfile = this.runtimes.get(agent.agent_id)?.getRuntimeProfile() ?? {
      model: agent.launch_contract.model,
      thinking_level: agent.launch_contract.thinking_level,
    };
    return {
      agent_id: agent.agent_id,
      parent_id: agent.parent_id,
      state: agent.active_turn_id ? "running" : "idle",
      availability: agent.availability,
      active_turn_id: agent.active_turn_id,
      latest_turn: agent.latest_result
        ? { turn_id: agent.latest_result.turn_id, status: agent.latest_result.status }
        : undefined,
      ...runtimeProfile,
      tools: [...agent.launch_contract.ordinary_tools],
      elapsed_ms: elapsed ?? agent.latest_result?.elapsed_ms,
      latest_activity_at: agent.latest_activity_at ?? agent.created_at,
      task: agent.task,
      latest_activity: agent.active_turn_id
        ? "turn running"
        : agent.latest_result
          ? `turn ${agent.latest_result.status}`
          : "created",
      child_count: directChildren.length,
      children,
    };
  }

  private buildAgentDetail(agent: PersistedAgent, includeDescendants = true): AgentDetail {
    const summary = this.buildAgentSummary(agent, includeDescendants);
    const runtimeUsage = this.runtimes.get(agent.agent_id)?.getUsage();
    return {
      ...summary,
      session_file: agent.session_file,
      launch_contract: structuredClone(agent.launch_contract),
      capability_ceiling: [...agent.capability_ceiling],
      spawn_entry_id: agent.spawn_entry_id,
      recent_messages: structuredClone(agent.recent_messages),
      latest_result: agent.latest_result ? structuredClone(agent.latest_result) : undefined,
      missing_dependencies: [...agent.missing_dependencies],
      unavailable_reason: agent.unavailable_reason,
      usage: runtimeUsage ?? agent.latest_result?.usage,
    };
  }

  private pruneDeliveryStateForDeletedAgent(agentId: string): void {
    const previousCoordinationDeliveries = this.deliveryLedger.coordinationDeliveries;
    this.deliveryLedger = pruneDeliveryLedgerAgents(this.deliveryLedger, [agentId]).ledger;
    for (const delivery of previousCoordinationDeliveries) {
      if (!this.isCoordinationDeliveryCurrent(delivery)) {
        this.waitHandedDeliveryIds.delete(delivery.delivery_id);
      }
    }
    for (const [key, messages] of this.pendingParentMessages) {
      for (const pending of messages) {
        if (!findCoordinationDelivery(this.deliveryLedger, pending.deliveryId)) {
          pending.claimed = true;
          pending.releaseClaim();
        }
      }
      const retained = messages.filter((pending) =>
        findCoordinationDelivery(this.deliveryLedger, pending.deliveryId),
      );
      if (retained.length === 0) this.pendingParentMessages.delete(key);
      else this.pendingParentMessages.set(key, retained);
    }
  }

  private pruneRecentMessageProjectionsForDeletedAgent(agentId: string): void {
    const belongsToDeletedSubtree = (sourceAgentId: string) =>
      sourceAgentId === agentId || sourceAgentId.startsWith(`${agentId}.`);
    for (const agent of this.agents.values()) {
      agent.recent_messages = agent.recent_messages.filter(
        (message) => !belongsToDeletedSubtree(message.source_agent_id),
      );
    }
  }

  private descendantsOf(agentId: string): PersistedAgent[] {
    const descendants: PersistedAgent[] = [];
    const queue = this.childrenOf(agentId);
    while (queue.length > 0) {
      const agent = queue.shift()!;
      descendants.push(agent);
      queue.push(...this.childrenOf(agent.agent_id));
    }
    return descendants;
  }

  private childrenOf(parentId: string): PersistedAgent[] {
    return [...this.agents.values()].filter((agent) => agent.parent_id === parentId);
  }

  private requireAgent(agentId: string): PersistedAgent {
    if (agentId === "root") throw new Error("Minimal subagents management target cannot be root");
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`Minimal subagents unknown agent: ${agentId}`);
    return agent;
  }

  private requireUsableAgent(agentId: string, operation: string): PersistedAgent {
    const agent = this.requireAgent(agentId);
    if (agent.availability === "unavailable") {
      throw new Error(
        agent.unavailable_reason ?? `Minimal subagents ${operation}: ${agentId} is unavailable`,
      );
    }
    if (agent.clone_error || !agent.session_file) {
      throw new Error(
        `Minimal subagents ${operation}: ${agent.clone_error ?? `${agentId} has no child session`}`,
      );
    }
    return agent;
  }

  private assertCallerExists(callerId: string): void {
    if (callerId === "root") return;
    this.requireUsableAgent(callerId, "caller");
  }

  private assertCallerMaySpawn(callerId: string): void {
    if (callerId === "root") return;
    const depth = getSubagentDepth(callerId);
    if (depth >= this.maxSubagentDepth) {
      throw new Error(
        `Minimal subagents maximum delegation depth reached: ${callerId} (depth ${depth}, max ${this.maxSubagentDepth})`,
      );
    }
    const caller = this.requireUsableAgent(callerId, "delegation");
    if (caller.launch_contract.delegation !== "fanout") {
      throw new Error(
        `Minimal subagents delegation denied: ${callerId} is not authorized for fanout`,
      );
    }
  }

  private validateFriendlyId(friendlyId: string): void {
    if (!FRIENDLY_AGENT_ID_PATTERN.test(friendlyId) || RESERVED_AGENT_IDS.has(friendlyId)) {
      throw new Error(
        `Minimal subagents invalid friendly agent ID: ${JSON.stringify(friendlyId)}; expected ${FRIENDLY_AGENT_ID_PATTERN.source}`,
      );
    }
  }

  private generateFriendlyId(parentId: string): string {
    let index = 1;
    while (true) {
      const friendlyId = `agent-${index}`;
      const agentId = this.buildChildAgentId(parentId, friendlyId);
      if (
        !this.agents.has(agentId) &&
        !this.pendingAgentIds.has(agentId) &&
        !this.tombstones.has(agentId)
      ) {
        return friendlyId;
      }
      index++;
    }
  }

  private createForkPlaceholder(agent: PersistedAgent, cloneError: string): PersistedAgent {
    return {
      ...structuredClone(agent),
      session_file: undefined,
      session_id: undefined,
      session_leaf_id: undefined,
      clone_error: cloneError,
      active_turn_id: undefined,
      active_turn_started_at: undefined,
      latest_activity_at: this.now().toISOString(),
      availability: "unavailable",
      missing_dependencies: [cloneError],
      unavailable_reason: cloneError,
    };
  }

  private rejectAllWaiters(error: Error): void {
    for (const [key, waiters] of this.waiters) {
      for (const waiter of waiters) {
        this.removeWaiter(key, waiter);
        waiter.reject(error);
      }
    }
  }

  private removeWaiter(key: string, waiter: TurnWaiter): void {
    const turnWaiters = this.waiters.get(key);
    turnWaiters?.delete(waiter);
    if (turnWaiters?.size === 0) this.waiters.delete(key);
    if (waiter.timeout) clearTimeout(waiter.timeout);
    if (waiter.abortSignal && waiter.abortListener) {
      waiter.abortSignal.removeEventListener("abort", waiter.abortListener);
    }
  }

  private resolveWaiterWithMessage(
    message: CoordinatorMessage,
    delivery: PersistedCoordinationDelivery,
  ): boolean {
    const destinationAgentId = message.details.destination_agent_id;
    if (!destinationAgentId) return false;
    const key = agentDeliveryKey(message.details.source_agent_id, message.details.source_turn_id);
    const turnWaiters = this.waiters.get(key);
    const waiter = [...(turnWaiters ?? [])].find(
      (candidate) => candidate.callerId === destinationAgentId,
    );
    if (!waiter) return false;
    this.deliveryLedger = setCoordinationDeliveryPath(
      this.deliveryLedger,
      delivery.delivery_id,
      "wait",
    );
    const currentDelivery = findCoordinationDelivery(this.deliveryLedger, delivery.delivery_id);
    if (currentDelivery) this.persistCoordinationDeliveryState(currentDelivery);
    this.waitHandedDeliveryIds.add(delivery.delivery_id);
    this.removeWaiter(key, waiter);
    waiter.resolve({
      event: "message",
      agent_id: message.details.source_agent_id,
      turn_id: message.details.source_turn_id,
      message_id: message.details.message_id,
      delivery_id: delivery.delivery_id,
      message: message.content,
    });
    return true;
  }

  private claimPendingParentMessage(
    callerId: string,
    sourceAgentId: string,
    sourceTurnId: string,
  ): WaitMessageResult | undefined {
    const key = agentDeliveryKey(sourceAgentId, sourceTurnId);
    const pendingMessages = this.pendingParentMessages.get(key);
    const index = pendingMessages?.findIndex(
      (pending) => pending.destinationAgentId === callerId && !pending.claimed,
    );
    if (index === undefined || index < 0 || !pendingMessages) {
      const retained = this.deliveryLedger.coordinationDeliveries
        .filter(
          (delivery) =>
            delivery.destination_agent_id === callerId &&
            delivery.message.details.source_agent_id === sourceAgentId &&
            delivery.message.details.source_turn_id === sourceTurnId &&
            !this.waitHandedDeliveryIds.has(delivery.delivery_id),
        )
        .sort((left, right) => left.sequence - right.sequence)[0];
      if (!retained) return undefined;
      this.deliveryLedger = setCoordinationDeliveryPath(
        this.deliveryLedger,
        retained.delivery_id,
        "wait",
      );
      const currentDelivery = findCoordinationDelivery(this.deliveryLedger, retained.delivery_id);
      if (currentDelivery) this.persistCoordinationDeliveryState(currentDelivery);
      this.waitHandedDeliveryIds.add(retained.delivery_id);
      return {
        event: "message",
        agent_id: sourceAgentId,
        turn_id: sourceTurnId,
        message_id: retained.message.details.message_id,
        delivery_id: retained.delivery_id,
        message: retained.message.content,
      };
    }
    const pending = pendingMessages[index];
    if (!pending) return undefined;
    const delivery = findCoordinationDelivery(this.deliveryLedger, pending.deliveryId);
    if (delivery) {
      this.deliveryLedger = setCoordinationDeliveryPath(
        this.deliveryLedger,
        delivery.delivery_id,
        "wait",
      );
      const currentDelivery = findCoordinationDelivery(this.deliveryLedger, delivery.delivery_id);
      if (currentDelivery) this.persistCoordinationDeliveryState(currentDelivery);
      this.waitHandedDeliveryIds.add(delivery.delivery_id);
    }
    pending.claimed = true;
    pending.cancelGrace?.();
    pending.releaseClaim();
    pendingMessages.splice(index, 1);
    if (pendingMessages.length === 0) this.pendingParentMessages.delete(key);
    return {
      event: "message",
      agent_id: sourceAgentId,
      turn_id: sourceTurnId,
      message_id: pending.message.details.message_id,
      delivery_id: pending.deliveryId,
      message: pending.message.content,
    };
  }

  private drainPendingParentMessages(
    callerId: string,
    sourceAgentId: string,
    sourceTurnId: string,
  ): WaitMessageResult[] {
    const messages: WaitMessageResult[] = [];
    let message = this.claimPendingParentMessage(callerId, sourceAgentId, sourceTurnId);
    while (message) {
      messages.push(message);
      message = this.claimPendingParentMessage(callerId, sourceAgentId, sourceTurnId);
    }
    return messages;
  }

  private queuePendingParentMessage(
    targetId: string,
    message: CoordinatorMessage,
    delivery: PersistedCoordinationDelivery,
  ): void {
    const key = agentDeliveryKey(message.details.source_agent_id, message.details.source_turn_id);
    const turnClaimed = () =>
      isDeliveryLedgerTurnClaimed(
        this.deliveryLedger,
        message.details.source_agent_id,
        message.details.source_turn_id,
      );
    const { promise: claimPromise, resolve: releaseClaim } = Promise.withResolvers<void>();
    const pending: PendingParentMessage = {
      deliveryId: delivery.delivery_id,
      message,
      destinationAgentId: targetId,
      claimed: false,
      claimPromise,
      releaseClaim,
    };
    const pendingMessages = this.pendingParentMessages.get(key) ?? [];
    pendingMessages.push(pending);
    this.pendingParentMessages.set(key, pendingMessages);

    if (
      isDeliveryLedgerTurnClaimed(
        this.deliveryLedger,
        message.details.source_agent_id,
        message.details.source_turn_id,
      )
    )
      return;

    const operation = this.enqueueRecipientDelivery(targetId, async () => {
      if (targetId !== "root") {
        await this.ensureRuntime(this.requireUsableAgent(targetId, "message"));
        if (!this.isCoordinationDeliveryCurrent(delivery)) return;
      }
      const graceMs = this.deliveryGraceMs();
      const gracePromise = new Promise<void>((resolve) => {
        if (graceMs <= 0) {
          resolve();
          return;
        }
        const timer = setTimeout(resolve, graceMs);
        pending.cancelGrace = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      await Promise.race([pending.claimPromise, gracePromise]);
      pending.cancelGrace?.();
      pending.cancelGrace = undefined;
      if (!this.acceptingOperations || pending.claimed || turnClaimed()) return;
      if (!this.acceptingOperations || pending.claimed || turnClaimed()) return;
      this.removePendingParentMessage(key, pending);
      this.waitHandedDeliveryIds.add(delivery.delivery_id);
      await this.deliverToRecipient(targetId, message, () =>
        this.isCoordinationDeliveryCurrent(delivery),
      );
    });
    void operation.catch((cause) => {
      this.removePendingParentMessage(key, pending);
      this.waitHandedDeliveryIds.delete(delivery.delivery_id);
      if (!this.isCoordinationDeliveryCurrent(delivery)) return;
      const deliveryError = cause instanceof Error ? cause.message : String(cause);
      this.deliveryLedger = setCoordinationDeliveryError(
        this.deliveryLedger,
        delivery.delivery_id,
        deliveryError,
      );
      const current = findCoordinationDelivery(this.deliveryLedger, delivery.delivery_id);
      if (current) this.persistCoordinationDeliveryState(current);
      this.dependencies.notify?.({
        type: "failure",
        agentId: message.details.source_agent_id,
        message: `Could not queue message ${message.details.message_id}: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      });
    });
  }

  private removePendingParentMessage(key: string, pending: PendingParentMessage): void {
    const pendingMessages = this.pendingParentMessages.get(key);
    if (!pendingMessages) return;
    const index = pendingMessages.indexOf(pending);
    if (index >= 0) pendingMessages.splice(index, 1);
    if (pendingMessages.length === 0) this.pendingParentMessages.delete(key);
  }

  private claimTerminalDelivery(callerId: string, result: TurnResult): void {
    if (!findTerminalDelivery(this.deliveryLedger, result.agent_id, result.turn_id)) return;
    this.claimDeliveryTurn(result.agent_id, result.turn_id);
    this.setTerminalDeliveryPathToWait(callerId, result);
  }

  private setTerminalDeliveryPathToWait(callerId: string, result: TurnResult): void {
    const delivery = findTerminalDelivery(this.deliveryLedger, result.agent_id, result.turn_id);
    if (!delivery || delivery.destination_agent_id !== callerId || delivery.path === "wait") return;
    this.applyDeliveryLedgerTransition(
      setTerminalDeliveryPath(this.deliveryLedger, result.agent_id, result.turn_id, "wait"),
    );
    const retained = findTerminalDelivery(this.deliveryLedger, result.agent_id, result.turn_id);
    if (!retained) return;
    this.dependencies.registry.append(
      createRegistryEvent(this.dependencies.registry.rootSessionId, "delivery-pending", {
        delivery: retained,
      }),
    );
  }

  private async cancelDuringShutdown(agentId: string): Promise<void> {
    const target = this.agents.get(agentId);
    if (!target) return;
    const affected = [target, ...this.descendantsOf(agentId)];
    for (const agent of affected) {
      if (!agent.active_turn_id) continue;
      const turnId = agent.active_turn_id;
      const runtime = this.runtimes.get(agent.agent_id);
      if (runtime) await runtime.abort();
      if (this.agents.get(agent.agent_id) !== agent) continue;
      this.settleTurn(agent, turnId, {
        agent_id: agent.agent_id,
        turn_id: turnId,
        status: "cancelled",
        output: "",
      });
    }
  }

  private async cancelActiveTurn(agent: PersistedAgent): Promise<string | undefined> {
    if (!agent.active_turn_id) return undefined;
    const turnId = agent.active_turn_id;
    const runtime = this.runtimes.get(agent.agent_id);
    if (runtime) await runtime.abort();
    if (this.agents.get(agent.agent_id) !== agent) return undefined;
    this.settleTurn(agent, turnId, {
      agent_id: agent.agent_id,
      turn_id: turnId,
      status: "cancelled",
      output: "",
    });
    this.dependencies.notify?.({
      type: "cancellation",
      agentId: agent.agent_id,
      message: `Cancelled ${agent.agent_id}`,
    });
    return turnId;
  }

  private assertCallerTargetsDirectChild(
    callerId: string,
    targetAgentId: string,
    operation: "wait" | "status" | "cancel" | "delete",
  ): void {
    if (targetAgentId === "root") {
      throw new Error(
        `Minimal subagents ${operation} authorization denied: ${callerId} cannot target ${targetAgentId}`,
      );
    }
    const target = this.requireAgent(targetAgentId);
    if (target.parent_id === callerId) return;
    throw new Error(
      `Minimal subagents ${operation} authorization denied: ${callerId} cannot target ${targetAgentId}`,
    );
  }

  private assertCallerCanManageAgent(
    callerId: string,
    targetAgentId: string,
    operation: "cancel" | "delete",
  ): void {
    this.assertCallerTargetsDirectChild(callerId, targetAgentId, operation);
    if (callerId === "root") return;
    const caller = this.agents.get(callerId);
    if (
      caller &&
      canAgentContractSpawn(
        caller.agent_id,
        caller.launch_contract.delegation,
        this.maxSubagentDepth,
      )
    ) {
      return;
    }
    throw new Error(
      `Minimal subagents ${operation} authorization denied: ${callerId} cannot target ${targetAgentId}`,
    );
  }

  private assertAccepting(): void {
    if (!this.acceptingOperations)
      throw new Error("Minimal subagents coordinator is shutting down");
  }

  private now(): Date {
    return this.dependencies.now?.() ?? new Date();
  }

  private deliveryGraceMs(): number {
    return this.dependencies.automaticDeliveryGraceMs ?? DEFAULT_AUTOMATIC_DELIVERY_GRACE_MS;
  }
}
