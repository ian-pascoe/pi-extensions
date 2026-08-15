import { fileURLToPath } from "node:url";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  buildSessionContext,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { MinimalSubagentsCoordinator } from "./minimal-subagents-coordinator.js";
import { resolveMinimalSubagentsSettings } from "./minimal-subagents-config.js";
import { snapshotCommittedContext } from "./minimal-subagents-context.js";
import {
  isForkDestinationForSource,
  rememberForkSnapshot,
  takeForkSnapshot,
} from "./minimal-subagents-fork-lifecycle.js";
import {
  buildEligibleModelIds,
  COORDINATOR_TOOL_NAMES,
  excludeCoordinatorTools,
} from "./minimal-subagents-capabilities.js";
import {
  CHILD_IDENTITY_ENTRY_TYPE,
  REGISTRY_ENTRY_TYPE,
  replayRegistryEntries,
  type RegistryReplayDiagnostic,
} from "./minimal-subagents-registry.js";
import { createCoordinatorToolSchemas } from "./minimal-subagents-tool-schemas.js";
import { findDeliveryEvidence, PiAgentSessionFactory } from "./minimal-subagents-sessions.js";
import { shutdownMinimalSubagentsSession } from "./minimal-subagents-shutdown.js";
import { createCoordinatorToolDefinitions } from "./minimal-subagents-tools.js";
import {
  renderMinimalSubagentsMessage,
  renderMinimalSubagentsResult,
} from "./minimal-subagents-rendering.js";
import { MinimalSubagentsUiController } from "./minimal-subagents-ui.js";
import type {
  CallerSnapshot,
  CoordinatorNotification,
  ForkSnapshot,
  PersistedAgent,
  RegistrySnapshot,
  RootConversationEndpoint,
} from "./minimal-subagents-types.js";

const EXTENSION_ENTRYPOINT = fileURLToPath(new URL("./index.ts", import.meta.url));

function currentConversationMessages(context: ExtensionContext): AgentMessage[] {
  const entries = context.sessionManager.getEntries() as SessionEntry[];
  const messages = buildSessionContext(entries, context.sessionManager.getLeafId()).messages;
  return snapshotCommittedContext(messages, !context.isIdle());
}

function rootCallerSnapshot(pi: ExtensionAPI, context: ExtensionContext): CallerSnapshot {
  if (!context.model) throw new Error("Minimal subagents spawn: root has no effective model");
  const activeTools = excludeCoordinatorTools(pi.getActiveTools());
  const availableTools = excludeCoordinatorTools(pi.getAllTools().map((tool) => tool.name));
  return {
    messages: currentConversationMessages(context),
    model: `${context.model.provider}/${context.model.id}`,
    thinkingLevel: context.thinkingLevel ?? pi.getThinkingLevel(),
    ordinaryTools: activeTools,
    capabilityCeiling: availableTools,
    availableTools,
    spawnEntryId: context.sessionManager.getLeafId() ?? "root",
  };
}

function createRootConversationEndpoint(
  pi: ExtensionAPI,
  context: ExtensionContext,
): RootConversationEndpoint {
  return {
    async queueCoordinatorMessage(message) {
      pi.sendMessage(
        {
          customType: message.customType,
          content: message.content,
          display: true,
          details: message.details,
        },
        {
          triggerTurn: true,
          deliverAs: "steer",
        },
      );
    },
    hasDeliveryEvidence: (sourceAgentId, sourceTurnId, deliveryId) =>
      findDeliveryEvidence(
        context.sessionManager.getBranch(),
        sourceAgentId,
        sourceTurnId,
        deliveryId,
      ),
    isIdle: () => context.isIdle(),
  };
}

function shouldSurfaceNotification(notification: CoordinatorNotification): boolean {
  return ["failure", "interruption", "unavailable", "fork-clone-failure"].includes(
    notification.type,
  );
}

function notificationLevel(notification: CoordinatorNotification): "info" | "warning" | "error" {
  if (notification.type === "failure" || notification.type === "fork-clone-failure") return "error";
  if (
    notification.type === "cancellation" ||
    notification.type === "interruption" ||
    notification.type === "unavailable"
  ) {
    return "warning";
  }
  return "info";
}

function hasHistoricalChildIdentity(entries: readonly SessionEntry[]): boolean {
  return entries.some(
    (entry) => entry.type === "custom" && entry.customType === CHILD_IDENTITY_ENTRY_TYPE,
  );
}

function reportInvalidRegistryRecords(
  context: ExtensionContext,
): (diagnostics: RegistryReplayDiagnostic[]) => void {
  return (diagnostics) => {
    const summaries = diagnostics
      .slice(0, 3)
      .map(({ entry_index: entryIndex, code }) => `entry ${entryIndex}: ${code}`)
      .join(", ");
    context.ui.notify(
      `Minimal subagents Registry ignored ${diagnostics.length} invalid active-branch record${diagnostics.length === 1 ? "" : "s"} (${summaries}${diagnostics.length > 3 ? ", …" : ""}).`,
      "warning",
    );
  };
}

function interruptSelectedForkBranch(snapshot: RegistrySnapshot): RegistrySnapshot {
  const interrupted = structuredClone(snapshot);
  for (const agent of interrupted.agents) {
    if (!agent.active_turn_id) continue;
    agent.latest_result = {
      agent_id: agent.agent_id,
      turn_id: agent.active_turn_id,
      status: "interrupted",
      output: "",
      error: "Turn interrupted because its source branch was forked",
    };
    agent.active_turn_id = undefined;
    agent.active_turn_started_at = undefined;
  }
  return interrupted;
}

function orderForkAgentsParentFirst(agents: readonly PersistedAgent[]): PersistedAgent[] {
  const byId = new Map(agents.map((agent) => [agent.agent_id, agent]));
  const depth = (agent: PersistedAgent) => {
    let value = 0;
    let parentId = agent.parent_id;
    const visited = new Set<string>();
    while (parentId !== "root" && !visited.has(parentId)) {
      visited.add(parentId);
      value++;
      parentId = byId.get(parentId)?.parent_id ?? "root";
    }
    return value;
  };
  return [...agents].sort((left, right) => depth(left) - depth(right));
}

function unavailableForkAgent(agent: PersistedAgent, error: string): PersistedAgent {
  return {
    ...structuredClone(agent),
    session_file: undefined,
    session_id: undefined,
    session_leaf_id: undefined,
    clone_error: error,
    active_turn_id: undefined,
    active_turn_started_at: undefined,
    availability: "unavailable",
    missing_dependencies: [error],
    unavailable_reason: error,
  };
}

async function cloneSelectedForkSessions(
  sessionFactory: PiAgentSessionFactory,
  snapshot: RegistrySnapshot,
  sourceRootSessionFile: string,
  sourceRootSessionId: string,
  context: ExtensionContext,
): Promise<ForkSnapshot> {
  const agents: PersistedAgent[] = [];
  const failedSubtrees = new Set<string>();
  for (const agent of orderForkAgentsParentFirst(snapshot.agents)) {
    const failedAncestor = [...failedSubtrees].find(
      (agentId) => agent.agent_id === agentId || agent.agent_id.startsWith(`${agentId}.`),
    );
    if (failedAncestor) {
      agents.push(unavailableForkAgent(agent, `Ancestor clone failed: ${failedAncestor}`));
      continue;
    }
    try {
      const clone = await sessionFactory.cloneForkSourceSession(agent, sourceRootSessionId);
      if (!clone.sessionLeafId) {
        throw new Error(
          `Minimal subagents fork recovery: no selected session leaf for ${agent.agent_id}`,
        );
      }
      agents.push({
        ...structuredClone(agent),
        session_file: clone.sessionFile,
        session_id: clone.sessionId,
        session_leaf_id: clone.sessionLeafId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failedSubtrees.add(agent.agent_id);
      agents.push(unavailableForkAgent(agent, message));
      context.ui.notify(`Fork recovery clone failed for ${agent.agent_id}: ${message}`, "error");
    }
  }
  return {
    ...structuredClone(snapshot),
    source_root_session_file: sourceRootSessionFile,
    source_root_session_id: sourceRootSessionId,
    agents,
  };
}

async function bindForkSnapshotToDestination(
  sessionFactory: PiAgentSessionFactory,
  snapshot: ForkSnapshot,
  context: ExtensionContext,
): Promise<ForkSnapshot> {
  const agents: PersistedAgent[] = [];
  const failedSubtrees = new Set<string>();
  for (const agent of orderForkAgentsParentFirst(snapshot.agents)) {
    const failedAncestor = [...failedSubtrees].find(
      (agentId) => agent.agent_id === agentId || agent.agent_id.startsWith(`${agentId}.`),
    );
    if (failedAncestor || !agent.session_file || !agent.session_id) {
      agents.push(
        unavailableForkAgent(
          agent,
          agent.clone_error ?? `Ancestor ownership failed: ${failedAncestor ?? agent.agent_id}`,
        ),
      );
      continue;
    }
    try {
      const owned = await sessionFactory.adoptForkSessionOwnership(
        agent,
        snapshot.source_root_session_id,
      );
      if (!owned.sessionLeafId) {
        throw new Error(
          `Minimal subagents fork ownership: no selected session leaf for ${agent.agent_id}`,
        );
      }
      agents.push({
        ...structuredClone(agent),
        session_file: owned.sessionFile,
        session_id: owned.sessionId,
        session_leaf_id: owned.sessionLeafId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failedSubtrees.add(agent.agent_id);
      agents.push(unavailableForkAgent(agent, message));
      context.ui.notify(`Fork ownership failed for ${agent.agent_id}: ${message}`, "error");
    }
  }
  return { ...structuredClone(snapshot), agents };
}

async function waitForRootSessionIdle(context: ExtensionContext): Promise<void> {
  while (!context.isIdle()) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Register the six root coordinator tools and bind root-owned persistent subagent lifecycle hooks. */
export default function minimalSubagentsExtension(pi: ExtensionAPI) {
  let coordinator: MinimalSubagentsCoordinator | undefined;
  let uiController: MinimalSubagentsUiController | undefined;
  let preparedFork:
    | { sourceSessionFile: string; selectedBranchSnapshot: RegistrySnapshot }
    | undefined;

  pi.registerMessageRenderer("minimal-subagents.message", renderMinimalSubagentsMessage);
  pi.registerMessageRenderer("minimal-subagents.result", renderMinimalSubagentsResult);

  pi.on("session_start", async (event, context) => {
    const rootSessionId = context.sessionManager.getSessionId();
    const agentDir = getAgentDir();
    const settingsManager = SettingsManager.create(context.cwd, agentDir, {
      projectTrusted: context.isProjectTrusted(),
    });
    const enabledModelPatterns = settingsManager.getEnabledModels();
    const availableModels = context.modelRegistry.getAvailable();
    const eligibleModelIds = buildEligibleModelIds({
      availableModels,
      scopedModels: context.scopedModels,
      scopeConfigured: enabledModelPatterns !== undefined,
    });
    const minimalSubagentsConfig = resolveMinimalSubagentsSettings(
      settingsManager,
      eligibleModelIds,
    );
    if (minimalSubagentsConfig.warnings.length > 0) {
      context.ui.notify(
        `Minimal subagents configuration warnings:\n- ${minimalSubagentsConfig.warnings.join("\n- ")}`,
        "warning",
      );
    }
    const models = [...availableModels];
    if (
      context.model &&
      !models.some(
        (model) => model.provider === context.model?.provider && model.id === context.model?.id,
      )
    ) {
      models.push(context.model);
    }
    const availableToolNames = excludeCoordinatorTools(pi.getAllTools().map((tool) => tool.name));
    const schemas = createCoordinatorToolSchemas(eligibleModelIds);
    let activeCoordinator!: MinimalSubagentsCoordinator;
    const sessionFactory = new PiAgentSessionFactory({
      cwd: context.cwd,
      agentDir,
      sessionDir: context.sessionManager.getSessionDir(),
      rootSessionId,
      extensionEntrypoint: EXTENSION_ENTRYPOINT,
      models,
      eligibleModelIds,
      modelScopeRestricted: enabledModelPatterns !== undefined,
      availableToolNames,
      projectTrusted: context.isProjectTrusted(),
      maxSubagentDepth: minimalSubagentsConfig.maxSubagentDepth,
      onChildSessionActivity: () => activeCoordinator.scheduleDeliveryReconciliation(),
      getCoordinatorTools: (callerId) =>
        createCoordinatorToolDefinitions({
          coordinator: activeCoordinator,
          callerId,
          allowFanoutTools: activeCoordinator.canAgentSpawn(callerId),
          modelRoles: minimalSubagentsConfig.modelRoles,
          schemas,
          captureCaller: (childContext) =>
            activeCoordinator.snapshotChildCaller(
              callerId,
              childContext.sessionManager.getLeafId() ?? callerId,
            ),
          onAttention: (message) => context.ui.notify(message, "error"),
        }),
    });
    activeCoordinator = new MinimalSubagentsCoordinator({
      sessions: sessionFactory,
      root: createRootConversationEndpoint(pi, context),
      maxSubagentDepth: minimalSubagentsConfig.maxSubagentDepth,
      registry: {
        rootSessionId,
        append: (registryEvent) => pi.appendEntry(REGISTRY_ENTRY_TYPE, registryEvent),
      },
      notify: (notification) => {
        uiController?.refresh();
        if (shouldSurfaceNotification(notification)) {
          context.ui.notify(notification.message, notificationLevel(notification));
        }
      },
    });
    coordinator = activeCoordinator;

    let snapshot: RegistrySnapshot;
    if (event.reason === "fork" && event.previousSessionFile) {
      const previousSession = SessionManager.open(event.previousSessionFile);
      const sourceRootSessionId = previousSession.getSessionId();
      let forkSnapshot = takeForkSnapshot(event.previousSessionFile);
      if (forkSnapshot?.source_root_session_id !== sourceRootSessionId) {
        if (forkSnapshot) {
          context.ui.notify(
            "Minimal subagents fork handoff rejected because its source root identity did not match.",
            "error",
          );
        }
        forkSnapshot = undefined;
      }
      if (!forkSnapshot) {
        if (
          isForkDestinationForSource(context.sessionManager.getHeader(), event.previousSessionFile)
        ) {
          const selectedSnapshot = interruptSelectedForkBranch(
            replayRegistryEntries(
              context.sessionManager.getBranch(),
              sourceRootSessionId,
              reportInvalidRegistryRecords(context),
            ),
          );
          forkSnapshot = await cloneSelectedForkSessions(
            sessionFactory,
            selectedSnapshot,
            event.previousSessionFile,
            sourceRootSessionId,
            context,
          );
        } else {
          context.ui.notify(
            "Minimal subagents fork recovery skipped because the destination selected branch could not be proven from parentSession provenance.",
            "warning",
          );
        }
      }
      snapshot = forkSnapshot
        ? await bindForkSnapshotToDestination(sessionFactory, forkSnapshot, context)
        : { agents: [], tombstones: [], deliveries: [] };
    } else {
      snapshot = replayRegistryEntries(
        context.sessionManager.getBranch(),
        rootSessionId,
        reportInvalidRegistryRecords(context),
      );
    }
    await activeCoordinator.restore(snapshot);
    activeCoordinator.writeCheckpoint();
    uiController = new MinimalSubagentsUiController(activeCoordinator, context);
    uiController.refresh();

    const rootTools = createCoordinatorToolDefinitions({
      coordinator: activeCoordinator,
      callerId: "root",
      allowFanoutTools: true,
      modelRoles: minimalSubagentsConfig.modelRoles,
      schemas,
      captureCaller: (toolContext) => rootCallerSnapshot(pi, toolContext),
      onActivity: () => uiController?.refresh(),
      onAttention: (message) => context.ui.notify(message, "error"),
    });
    for (const tool of rootTools) pi.registerTool(tool);
    pi.setActiveTools([...new Set([...pi.getActiveTools(), ...COORDINATOR_TOOL_NAMES])]);

    if (hasHistoricalChildIdentity(context.sessionManager.getBranch() as SessionEntry[])) {
      context.ui.notify(
        "Opened a former subagent session directly. It is now an independent root; former descendants and parent messaging were not restored. Concurrent ownership by its original root is unsupported.",
        "warning",
      );
    }
  });

  pi.on("session_before_fork", async (event, context) => {
    const sourceSessionFile = context.sessionManager.getSessionFile();
    if (!sourceSessionFile) {
      preparedFork = undefined;
      return;
    }
    const selectedEntry = context.sessionManager.getEntry(event.entryId);
    const selectedLeafId =
      event.position === "before" ? (selectedEntry?.parentId ?? undefined) : event.entryId;
    const selectedBranch =
      event.position === "before" && selectedEntry?.parentId === null
        ? []
        : context.sessionManager.getBranch(selectedLeafId);
    preparedFork = {
      sourceSessionFile,
      selectedBranchSnapshot: interruptSelectedForkBranch(
        replayRegistryEntries(
          selectedBranch,
          context.sessionManager.getSessionId(),
          reportInvalidRegistryRecords(context),
        ),
      ),
    };
  });

  pi.on("session_tree", async (_event, context) => {
    if (!coordinator) return;
    const snapshot = replayRegistryEntries(
      context.sessionManager.getBranch(),
      context.sessionManager.getSessionId(),
      reportInvalidRegistryRecords(context),
    );
    await coordinator.restore(snapshot);
    coordinator.writeCheckpoint();
    uiController?.refresh();
  });

  pi.on("message_end", async (event) => {
    if (!coordinator) return;
    if (event.message.role === "toolResult" || event.message.role === "custom") {
      await coordinator.reconcileDeliveries();
      uiController?.refresh();
    }
  });

  pi.on("agent_settled", async (_event, context) => {
    if (!coordinator) return;
    if (context.isIdle()) coordinator.markRecipientIdle("root");
    uiController?.refresh();
  });

  pi.on("session_shutdown", async (event, context) => {
    if (coordinator) {
      if (event.reason === "fork" && preparedFork) {
        await coordinator.restore(preparedFork.selectedBranchSnapshot);
        rememberForkSnapshot(await coordinator.prepareFork(preparedFork.sourceSessionFile));
      }
      await shutdownMinimalSubagentsSession(event.reason, coordinator, {
        isRootIdle: () => context.isIdle(),
        waitForRootIdle: () => waitForRootSessionIdle(context),
      });
    }
    uiController?.dispose();
    uiController = undefined;
    coordinator = undefined;
    preparedFork = undefined;
  });
}
