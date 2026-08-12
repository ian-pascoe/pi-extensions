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
import { rememberForkSnapshot, takeForkSnapshot } from "./minimal-subagents-fork-lifecycle.js";
import {
  buildEligibleModelIds,
  COORDINATOR_TOOL_NAMES,
  excludeCoordinatorTools,
} from "./minimal-subagents-capabilities.js";
import {
  CHILD_IDENTITY_ENTRY_TYPE,
  REGISTRY_ENTRY_TYPE,
  replayRegistryEntries,
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
    async steerCoordinatorMessage(message) {
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
    hasDeliveryEvidence: (sourceAgentId, sourceTurnId) =>
      findDeliveryEvidence(context.sessionManager.getEntries(), sourceAgentId, sourceTurnId),
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

function replayPreviousRoot(previousSessionFile: string): RegistrySnapshot {
  const previousSession = SessionManager.open(previousSessionFile);
  const previousRootSessionId = previousSession.getSessionId();
  return replayRegistryEntries(previousSession.getEntries(), previousRootSessionId);
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
  let preparedFork: ForkSnapshot | undefined;

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
      let forkSnapshot = takeForkSnapshot(event.previousSessionFile);
      if (!forkSnapshot) {
        await activeCoordinator.restore(replayPreviousRoot(event.previousSessionFile));
        forkSnapshot = await activeCoordinator.prepareFork(event.previousSessionFile);
      }
      snapshot = forkSnapshot;
    } else {
      snapshot = replayRegistryEntries(context.sessionManager.getEntries(), rootSessionId);
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

    if (hasHistoricalChildIdentity(context.sessionManager.getEntries() as SessionEntry[])) {
      context.ui.notify(
        "Opened a former subagent session directly. It is now an independent root; former descendants and parent messaging were not restored. Concurrent ownership by its original root is unsupported.",
        "warning",
      );
    }
  });

  pi.on("session_before_fork", async (_event, context) => {
    const sessionFile = context.sessionManager.getSessionFile();
    if (!coordinator || !sessionFile) return;
    preparedFork = await coordinator.prepareFork(sessionFile);
    rememberForkSnapshot(preparedFork);
  });

  pi.on("message_end", async (event) => {
    if (!coordinator) return;
    if (event.message.role === "toolResult" || event.message.role === "custom") {
      await coordinator.reconcileDeliveries();
      uiController?.refresh();
    }
  });

  pi.on("session_shutdown", async (event, context) => {
    if (coordinator) {
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
