import { fileURLToPath } from "node:url";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  buildSessionContext,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type ExtensionFactory,
  type MessageEndEvent,
  type SessionBeforeForkEvent,
  type SessionEntry,
  type SessionShutdownEvent,
  type SessionStartEvent,
  type SessionTreeEvent,
} from "@earendil-works/pi-coding-agent";
import {
  createSubagentAccessBranchRecord,
  reconcileCoordinatorToolAccess,
  replaySubagentAccessBranch,
  resolveSubagentAccessSnapshot,
  SUBAGENT_ACCESS_ENTRY_TYPE,
  type SubagentAccessOverride,
  type SubagentAccessReplayDiagnostic,
} from "./minimal-subagents-access.js";
import {
  completeSubagentsCommandArguments,
  parseSubagentsCommandArguments,
  type SubagentsCommand,
} from "./minimal-subagents-command.js";
import { MinimalSubagentsCoordinator } from "./minimal-subagents-coordinator.js";
import {
  resolveMinimalSubagentsSettings,
  type ResolvedSubagentAccessSettings,
} from "./minimal-subagents-config.js";
import { snapshotCommittedContext } from "./minimal-subagents-context.js";
import {
  isForkDestinationForSource,
  rememberForkSnapshot,
  takeForkSnapshot,
} from "./minimal-subagents-fork-lifecycle.js";
import {
  buildEligibleModelIds,
  excludeCoordinatorTools,
} from "./minimal-subagents-capabilities.js";
import {
  CHILD_IDENTITY_ENTRY_TYPE,
  REGISTRY_ENTRY_TYPE,
  replayRegistryEntries,
  type RegistryReplayDiagnostic,
} from "./minimal-subagents-registry.js";
import { createCoordinatorToolSchemas } from "./minimal-subagents-tool-schemas.js";
import {
  findDeliveryEvidence,
  PiAgentSessionFactory,
  type PiAgentSessionFactoryOptions,
  type RuntimeToolAdapter,
  unavailableAgent,
} from "./minimal-subagents-sessions.js";
import { shutdownMinimalSubagentsSession } from "./minimal-subagents-shutdown.js";
import { MinimalSubagentsSettingsWriter } from "./minimal-subagents-settings-writer.js";
import {
  MinimalSubagentsStatusPanelController,
  type MinimalSubagentsStatusAccess,
} from "./minimal-subagents-status-panel.js";
import { createCoordinatorToolDefinitions } from "./minimal-subagents-tools.js";
import {
  renderMinimalSubagentsMessage,
  renderMinimalSubagentsResult,
} from "./minimal-subagents-rendering.js";
import { MinimalSubagentsUiController } from "./minimal-subagents-ui.js";
import type {
  AgentSessionFactory,
  CallerSnapshot,
  CoordinatorNotification,
  ForkSnapshot,
  PersistedAgent,
  PersistedSessionIdentity,
  RegistrySnapshot,
  RootConversationEndpoint,
} from "./minimal-subagents-types.js";

const EXTENSION_ENTRYPOINT = fileURLToPath(new URL("./index.ts", import.meta.url));
const CODEX_CONVERSION_TOOL_ADAPTER_SOURCE = "npm:@howaboua/pi-codex-conversion";

function codexConversionRuntimeToolAdapters(pi: ExtensionAPI): RuntimeToolAdapter[] {
  const extensions = new Map<
    string,
    {
      path: string;
      source: string;
      toolNames: string[];
    }
  >();
  for (const tool of pi.getAllTools()) {
    const { path, source } = tool.sourceInfo;
    if (path.startsWith("<")) continue;
    const extension = extensions.get(path) ?? { path, source, toolNames: [] };
    extension.toolNames.push(tool.name);
    extensions.set(path, extension);
  }
  return [...extensions.values()]
    .filter((extension) => extension.source.startsWith(CODEX_CONVERSION_TOOL_ADAPTER_SOURCE))
    .map((extension) => ({ toolNames: extension.toolNames }));
}

function currentConversationMessages(context: ExtensionContext): AgentMessage[] {
  const entries = context.sessionManager.getEntries();
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
    isIdle: () => context.isIdle(),
    hasDeliveryEvidence: (sourceAgentId, sourceTurnId, deliveryId) =>
      findDeliveryEvidence(
        context.sessionManager.getBranch(),
        sourceAgentId,
        sourceTurnId,
        deliveryId,
      ),
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
  return unavailableAgent(agent, error);
}

/** One per-agent fork rebind step returning the destination session identity. */
type ForkAgentRebind = (agent: PersistedAgent) => Promise<PersistedSessionIdentity>;

interface ForkRebindOptions {
  /** Require an existing clone session before rebinding (ownership pass only). */
  readonly requiresCloneSession: boolean;
  /** Message for agents skipped because an ancestor's rebind failed. */
  readonly skippedMessage: (agent: PersistedAgent, failedAncestor: string) => string;
  /** Human label used in failure notifications. */
  readonly notifyLabel: string;
}

/** Walk fork agents parent-first, rebind each session, and quarantine failed subtrees. */
async function rebindForkAgents(
  snapshotAgents: readonly PersistedAgent[],
  rebind: ForkAgentRebind,
  options: ForkRebindOptions,
  context: ExtensionContext,
): Promise<PersistedAgent[]> {
  const agents: PersistedAgent[] = [];
  const failedSubtrees = new Set<string>();
  for (const agent of orderForkAgentsParentFirst(snapshotAgents)) {
    const failedAncestor = [...failedSubtrees].find(
      (agentId) => agent.agent_id === agentId || agent.agent_id.startsWith(`${agentId}.`),
    );
    const missingCloneSession =
      options.requiresCloneSession && (!agent.session_file || !agent.session_id);
    if (failedAncestor !== undefined || missingCloneSession) {
      const message =
        failedAncestor !== undefined
          ? options.skippedMessage(agent, failedAncestor)
          : (agent.clone_error ?? `Ancestor ownership failed: ${agent.agent_id}`);
      agents.push(unavailableForkAgent(agent, message));
      continue;
    }
    try {
      const identity = await rebind(agent);
      if (!identity.sessionLeafId) {
        throw new Error(
          `Minimal subagents fork recovery: no selected session leaf for ${agent.agent_id}`,
        );
      }
      agents.push({
        ...structuredClone(agent),
        session_file: identity.sessionFile,
        session_id: identity.sessionId,
        session_leaf_id: identity.sessionLeafId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failedSubtrees.add(agent.agent_id);
      agents.push(unavailableForkAgent(agent, message));
      context.ui.notify(`${options.notifyLabel} for ${agent.agent_id}: ${message}`, "error");
    }
  }
  return agents;
}

async function cloneSelectedForkSessions(
  sessionFactory: AgentSessionFactory,
  snapshot: RegistrySnapshot,
  sourceRootSessionFile: string,
  sourceRootSessionId: string,
  context: ExtensionContext,
): Promise<ForkSnapshot> {
  const agents = await rebindForkAgents(
    snapshot.agents,
    (agent) => sessionFactory.cloneForkSourceSession(agent, sourceRootSessionId),
    {
      requiresCloneSession: false,
      skippedMessage: (_agent, failedAncestor) => `Ancestor clone failed: ${failedAncestor}`,
      notifyLabel: "Fork recovery clone failed",
    },
    context,
  );
  return {
    ...structuredClone(snapshot),
    source_root_session_file: sourceRootSessionFile,
    source_root_session_id: sourceRootSessionId,
    agents,
  };
}

async function bindForkSnapshotToDestination(
  sessionFactory: AgentSessionFactory,
  snapshot: ForkSnapshot,
  context: ExtensionContext,
): Promise<ForkSnapshot> {
  const agents = await rebindForkAgents(
    snapshot.agents,
    (agent) => sessionFactory.adoptForkSessionOwnership(agent, snapshot.source_root_session_id),
    {
      requiresCloneSession: true,
      skippedMessage: () => "Ancestor ownership failed",
      notifyLabel: "Fork ownership failed",
    },
    context,
  );
  return { ...structuredClone(snapshot), agents };
}

async function waitForRootSessionIdle(context: ExtensionContext): Promise<void> {
  while (!context.isIdle()) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

interface ActiveSubagentAccessSession {
  readonly agentDir: string;
  readonly eligibleModelIds: readonly string[];
  readonly context: ExtensionContext;
  settings: ResolvedSubagentAccessSettings;
  branchOverride: SubagentAccessOverride;
}

function reportInvalidSubagentAccessRecords(
  context: ExtensionContext,
): (diagnostics: SubagentAccessReplayDiagnostic[]) => void {
  return (diagnostics) => {
    context.ui.notify(
      `Minimal subagents ignored ${diagnostics.length} invalid Subagent Access branch record${diagnostics.length === 1 ? "" : "s"}.`,
      "warning",
    );
  };
}

/** SDK and runtime construction effects required by the Minimal Subagents lifecycle controller. */
export interface MinimalSubagentsLifecycleEffects {
  /** Resolve Pi's current agent directory without coupling lifecycle tests to process configuration. */
  getAgentDirectory(): string;
  /** Construct the Pi child-session adapter after root settings and model scope are resolved. */
  createSessionFactory(options: PiAgentSessionFactoryOptions): AgentSessionFactory;
}

const productionLifecycleEffects: MinimalSubagentsLifecycleEffects = {
  getAgentDirectory: getAgentDir,
  createSessionFactory: (options) => new PiAgentSessionFactory(options),
};

/** Own coordinator, UI, and prepared-fork state for one root Pi session lifecycle. */
export class MinimalSubagentsLifecycleController {
  private coordinator: MinimalSubagentsCoordinator | undefined;
  private uiController: MinimalSubagentsUiController | undefined;
  private statusPanelController: MinimalSubagentsStatusPanelController | undefined;
  private accessSession: ActiveSubagentAccessSession | undefined;
  private preparedFork:
    | { sourceSessionFile: string; selectedBranchSnapshot: RegistrySnapshot }
    | undefined;

  /** Bind one controller to one Pi extension instance and its runtime construction effects. */
  constructor(
    private readonly pi: ExtensionAPI,
    private readonly effects: MinimalSubagentsLifecycleEffects,
  ) {}

  /** Register renderers and the six Pi lifecycle event handlers owned by Minimal Subagents. */
  register(): void {
    this.pi.registerMessageRenderer("minimal-subagents.message", renderMinimalSubagentsMessage);
    this.pi.registerMessageRenderer("minimal-subagents.result", renderMinimalSubagentsResult);
    this.pi.registerCommand("subagents", {
      description: "Control Subagent Access and inspect Child Agents",
      getArgumentCompletions: completeSubagentsCommandArguments,
      handler: (args, context) => this.runSubagentsCommand(args, context),
    });

    this.pi.on("session_start", (event, context) => this.startSession(event, context));
    this.pi.on("session_before_fork", (event, context) => this.prepareSessionFork(event, context));
    this.pi.on("session_tree", (event, context) => this.restoreSessionTree(event, context));
    this.pi.on("message_end", (event, context) => this.reconcileMessageDelivery(event, context));
    this.pi.on("session_shutdown", (event, context) => this.shutdownSession(event, context));
  }

  private async startSession(event: SessionStartEvent, context: ExtensionContext): Promise<void> {
    const rootSessionId = context.sessionManager.getSessionId();
    const agentDir = this.effects.getAgentDirectory();
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
    const branchOverride = replaySubagentAccessBranch(
      context.sessionManager.getBranch(),
      reportInvalidSubagentAccessRecords(context),
    ).override;
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
    const availableToolNames = excludeCoordinatorTools(
      this.pi.getAllTools().map((tool) => tool.name),
    );
    const schemas = createCoordinatorToolSchemas(eligibleModelIds);
    let activeCoordinator: MinimalSubagentsCoordinator | undefined;
    const requireActiveCoordinator = (): MinimalSubagentsCoordinator => {
      if (!activeCoordinator) {
        throw new Error("Minimal subagents lifecycle: coordinator is not initialized");
      }
      return activeCoordinator;
    };
    const sessionFactory = this.effects.createSessionFactory({
      cwd: context.cwd,
      agentDir,
      sessionDir: context.sessionManager.getSessionDir(),
      rootSessionId,
      extensionEntrypoint: EXTENSION_ENTRYPOINT,
      models,
      eligibleModelIds,
      modelScopeRestricted: enabledModelPatterns !== undefined,
      availableToolNames,
      getRuntimeToolAdapters: () => codexConversionRuntimeToolAdapters(this.pi),
      projectTrusted: context.isProjectTrusted(),
      maxSubagentDepth: minimalSubagentsConfig.maxSubagentDepth,
      onChildSessionActivity: () => activeCoordinator?.scheduleDeliveryReconciliation(),
      getCoordinatorTools: (callerId) => {
        const coordinator = requireActiveCoordinator();
        return createCoordinatorToolDefinitions({
          coordinator,
          callerId,
          allowFanoutTools: coordinator.canAgentSpawn(callerId),
          modelRoles: minimalSubagentsConfig.modelRoles,
          schemas,
          captureCaller: (childContext) =>
            coordinator.snapshotChildCaller(
              callerId,
              childContext.sessionManager.getLeafId() ?? callerId,
            ),
          onAttention: (message) => context.ui.notify(message, "error"),
        });
      },
    });
    activeCoordinator = new MinimalSubagentsCoordinator({
      sessions: sessionFactory,
      root: createRootConversationEndpoint(this.pi, context),
      maxSubagentDepth: minimalSubagentsConfig.maxSubagentDepth,
      registry: {
        rootSessionId,
        append: (registryEvent) => this.pi.appendEntry(REGISTRY_ENTRY_TYPE, registryEvent),
      },
      notify: (notification) => {
        this.uiController?.refresh();
        if (shouldSurfaceNotification(notification)) {
          context.ui.notify(notification.message, notificationLevel(notification));
        }
      },
    });
    this.coordinator = activeCoordinator;

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
    this.uiController = new MinimalSubagentsUiController(activeCoordinator, context);
    this.uiController.refresh();

    const rootTools = createCoordinatorToolDefinitions({
      coordinator: activeCoordinator,
      callerId: "root",
      allowFanoutTools: true,
      modelRoles: minimalSubagentsConfig.modelRoles,
      schemas,
      captureCaller: (toolContext) => rootCallerSnapshot(this.pi, toolContext),
      onActivity: () => this.uiController?.refresh(),
      onAttention: (message) => context.ui.notify(message, "error"),
    });
    for (const tool of rootTools) this.pi.registerTool(tool);
    this.accessSession = {
      agentDir,
      eligibleModelIds,
      context,
      settings: minimalSubagentsConfig.subagentAccess,
      branchOverride,
    };
    this.applySubagentAccess();
    this.statusPanelController = new MinimalSubagentsStatusPanelController(
      activeCoordinator,
      context,
      () => this.currentSubagentStatusAccess(),
    );

    if (hasHistoricalChildIdentity(context.sessionManager.getBranch())) {
      context.ui.notify(
        "Opened a former subagent session directly. It is now an independent root; former descendants and parent messaging were not restored. Concurrent ownership by its original root is unsupported.",
        "warning",
      );
    }
  }

  private async prepareSessionFork(
    event: SessionBeforeForkEvent,
    context: ExtensionContext,
  ): Promise<void> {
    const sourceSessionFile = context.sessionManager.getSessionFile();
    if (!sourceSessionFile) {
      this.preparedFork = undefined;
      return;
    }
    const selectedEntry = context.sessionManager.getEntry(event.entryId);
    const selectedLeafId =
      event.position === "before" ? (selectedEntry?.parentId ?? undefined) : event.entryId;
    const selectedBranch =
      event.position === "before" && selectedEntry?.parentId === null
        ? []
        : context.sessionManager.getBranch(selectedLeafId);
    this.preparedFork = {
      sourceSessionFile,
      selectedBranchSnapshot: interruptSelectedForkBranch(
        replayRegistryEntries(
          selectedBranch,
          context.sessionManager.getSessionId(),
          reportInvalidRegistryRecords(context),
        ),
      ),
    };
  }

  private async restoreSessionTree(
    _event: SessionTreeEvent,
    context: ExtensionContext,
  ): Promise<void> {
    if (!this.coordinator) return;
    const snapshot = replayRegistryEntries(
      context.sessionManager.getBranch(),
      context.sessionManager.getSessionId(),
      reportInvalidRegistryRecords(context),
    );
    await this.coordinator.restore(snapshot);
    this.coordinator.writeCheckpoint();
    const replayedAccess = replaySubagentAccessBranch(
      context.sessionManager.getBranch(),
      reportInvalidSubagentAccessRecords(context),
    );
    if (this.accessSession) {
      this.accessSession.branchOverride = replayedAccess.override;
      this.applySubagentAccess();
    }
    this.uiController?.refresh();
  }

  private async runSubagentsCommand(args: string, context: ExtensionCommandContext): Promise<void> {
    const parsed = parseSubagentsCommandArguments(args);
    if (!parsed.ok) {
      context.ui.notify(parsed.message, "error");
      return;
    }
    if (!this.accessSession || !this.coordinator) {
      context.ui.notify("Minimal subagents is not active for this session.", "error");
      return;
    }
    if (parsed.command.action === "status") {
      await this.statusPanelController?.open();
      return;
    }
    await this.changeSubagentAccess(parsed.command, context);
  }

  private async changeSubagentAccess(
    command: Exclude<SubagentsCommand, { action: "status" }>,
    context: ExtensionCommandContext,
  ): Promise<void> {
    const accessSession = this.accessSession;
    if (!accessSession) return;
    const requestedOverride: SubagentAccessOverride =
      command.action === "reset" ? "inherit" : command.action === "enable" ? "enabled" : "disabled";

    let persistedScope: "global" | "project" | undefined;
    if (command.scope !== "session") {
      if (command.scope === "project" && !context.isProjectTrusted()) {
        context.ui.notify(
          "Minimal subagents project settings write refused because the project is not trusted.",
          "error",
        );
        return;
      }
      const writeResult = await new MinimalSubagentsSettingsWriter(
        context,
        () => accessSession.agentDir,
      ).writeMinimalSubagentsEnabled(
        command.scope,
        command.action === "reset" ? undefined : command.action === "enable",
      );
      if (!writeResult.ok) {
        context.ui.notify(writeResult.error.message, "error");
        return;
      }
      persistedScope = command.scope;
      const settingsManager = SettingsManager.create(context.cwd, accessSession.agentDir, {
        projectTrusted: context.isProjectTrusted(),
      });
      accessSession.settings = resolveMinimalSubagentsSettings(
        settingsManager,
        accessSession.eligibleModelIds,
      ).subagentAccess;
    }

    await context.waitForIdle();
    try {
      this.pi.appendEntry(
        SUBAGENT_ACCESS_ENTRY_TYPE,
        createSubagentAccessBranchRecord(requestedOverride),
      );
      accessSession.branchOverride = requestedOverride;
      this.applySubagentAccess();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      context.ui.notify(
        persistedScope
          ? `Minimal subagents ${persistedScope} default changed, but the current session did not: ${detail}`
          : `Minimal subagents could not change the current session: ${detail}`,
        "error",
      );
      return;
    }

    const snapshot = this.currentSubagentAccessSnapshot();
    context.ui.notify(
      `Subagent Access ${snapshot.enabled ? "enabled" : "disabled"} (${command.scope}).`,
      "info",
    );
  }

  private applySubagentAccess(): void {
    const accessSession = this.accessSession;
    if (!accessSession) return;
    const snapshot = resolveSubagentAccessSnapshot(
      accessSession.settings,
      accessSession.branchOverride,
      this.pi.getActiveTools(),
    );
    this.pi.setActiveTools(
      reconcileCoordinatorToolAccess(this.pi.getActiveTools(), snapshot.enabled),
    );
  }

  private currentSubagentAccessSnapshot() {
    const accessSession = this.accessSession;
    if (!accessSession) throw new Error("Minimal subagents access: no active session");
    return resolveSubagentAccessSnapshot(
      accessSession.settings,
      accessSession.branchOverride,
      this.pi.getActiveTools(),
    );
  }

  private currentSubagentStatusAccess(): MinimalSubagentsStatusAccess {
    const access = this.currentSubagentAccessSnapshot();
    return {
      enabled: access.enabled,
      source: access.source,
      branch: access.branchOverride,
      global: access.globalEnabled,
      project: access.projectEnabled,
      projectTrusted: this.accessSession?.context.isProjectTrusted() ?? false,
      activeCoordinatorToolCount: access.coordinatorTools.activeCount,
    };
  }

  private async reconcileMessageDelivery(
    event: MessageEndEvent,
    _context: ExtensionContext,
  ): Promise<void> {
    if (!this.coordinator) return;
    if (event.message.role === "toolResult" || event.message.role === "custom") {
      await this.coordinator.reconcileDeliveries();
      this.uiController?.refresh();
    }
  }

  private async shutdownSession(
    event: SessionShutdownEvent,
    context: ExtensionContext,
  ): Promise<void> {
    this.statusPanelController?.dispose();
    this.statusPanelController = undefined;
    if (this.coordinator) {
      if (event.reason === "fork" && this.preparedFork) {
        await this.coordinator.restore(this.preparedFork.selectedBranchSnapshot);
        rememberForkSnapshot(
          await this.coordinator.prepareFork(this.preparedFork.sourceSessionFile),
        );
      }
      await shutdownMinimalSubagentsSession(event.reason, this.coordinator, {
        isRootIdle: () => context.isIdle(),
        waitForRootIdle: () => waitForRootSessionIdle(context),
      });
    }
    this.uiController?.dispose();
    this.uiController = undefined;
    this.coordinator = undefined;
    this.accessSession = undefined;
    this.preparedFork = undefined;
  }
}

/** Compose the Minimal Subagents extension with production or faithful SDK runtime effects. */
export function createMinimalSubagentsExtension(
  effects: MinimalSubagentsLifecycleEffects = productionLifecycleEffects,
): ExtensionFactory {
  return (pi) => {
    new MinimalSubagentsLifecycleController(pi, effects).register();
  };
}

const minimalSubagentsExtension = createMinimalSubagentsExtension();

export default minimalSubagentsExtension;
