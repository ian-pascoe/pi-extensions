import { execFile } from "node:child_process";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { resolve } from "node:path";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model, Usage } from "@earendil-works/pi-ai";
import { clampThinkingLevel } from "@earendil-works/pi-ai/compat";
import {
  AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  estimateTokens,
  findCutPoint,
  generateSummaryWithUsage,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  sessionEntryToContextMessages,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  buildSubagentSystemPrompt,
  snapshotCommittedContext,
} from "./minimal-subagents-context.js";
import {
  canAgentContractSpawn,
  DEFAULT_MAX_SUBAGENT_DEPTH,
  getSubagentDepth,
} from "./minimal-subagents-capabilities.js";
import { CHILD_IDENTITY_ENTRY_TYPE } from "./minimal-subagents-registry.js";
import { addMinimalSubagentsUsage } from "./minimal-subagents-usage.js";
import type {
  AgentSessionFactory,
  ChildAgentRuntime,
  CoordinatorMessage,
  PersistedAgent,
  PersistedSessionIdentity,
  ProjectContextMode,
  RuntimeCreationRequest,
  RuntimeTurnOutcome,
} from "./minimal-subagents-types.js";

const PI_BUILTIN_ORDINARY_TOOL_NAMES = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "bash",
  "edit",
  "write",
]);

interface PersistentIdentityOptions {
  agent: PersistedAgent;
  importedMessages: AgentMessage[];
  cwd: string;
  sessionDir: string;
  rootSessionId: string;
}

interface ChildResourceLoaderOptionsInput {
  cwd: string;
  agentDir: string;
  projectContext: ProjectContextMode;
  extensionEntrypoint: string;
  systemPromptBlock: string;
  ordinaryToolNames?: readonly string[];
  settingsManager?: SettingsManager;
}

/** Configures root ownership, model scope, child resources, and coordinator tool injection for Pi sessions. */
export interface PiAgentSessionFactoryOptions {
  cwd: string;
  agentDir: string;
  sessionDir: string;
  rootSessionId: string;
  extensionEntrypoint: string;
  models: readonly Model<any>[];
  eligibleModelIds: readonly string[];
  modelScopeRestricted: boolean;
  availableToolNames: readonly string[];
  projectTrusted: boolean;
  maxSubagentDepth?: number;
  getCoordinatorTools: (callerId: string) => ToolDefinition[];
  onChildSessionActivity?: () => void;
}

/** Build one child prompt using the active delegation depth rather than persisted launch state. */
export function buildDepthBoundSubagentPrompt(
  agent: PersistedAgent,
  maxSubagentDepth = DEFAULT_MAX_SUBAGENT_DEPTH,
): string {
  return buildSubagentSystemPrompt(agent.agent_id, agent.parent_id, {
    canSpawn: canAgentContractSpawn(
      agent.agent_id,
      agent.launch_contract.delegation,
      maxSubagentDepth,
    ),
    remainingDepth: Math.max(0, maxSubagentDepth - getSubagentDepth(agent.agent_id)),
  });
}

function canonicalPath(path: string): string {
  const absolutePath = resolve(path);
  return existsSync(absolutePath) ? realpathSync(absolutePath) : absolutePath;
}

function appendImportedMessage(sessionManager: SessionManager, message: AgentMessage): void {
  if (message.role === "compactionSummary") {
    sessionManager.appendCustomMessageEntry(
      "minimal-subagents.imported-compaction",
      message.summary,
      false,
    );
    return;
  }
  if (message.role === "branchSummary") {
    sessionManager.appendCustomMessageEntry(
      "minimal-subagents.imported-branch-summary",
      message.summary,
      false,
    );
    return;
  }
  sessionManager.appendMessage(message as Parameters<SessionManager["appendMessage"]>[0]);
}

/** Create and force-flush a writable child JSONL identity before its first model response. */
export function createPersistentChildIdentity(
  options: PersistentIdentityOptions,
): PersistedSessionIdentity {
  let sessionManager = SessionManager.create(options.cwd, options.sessionDir);
  sessionManager.appendCustomEntry(CHILD_IDENTITY_ENTRY_TYPE, {
    version: 1,
    original_root_session_id: options.rootSessionId,
    canonical_agent_id: options.agent.agent_id,
    direct_parent_id: options.agent.parent_id,
    created_at: options.agent.created_at,
  });
  sessionManager.appendSessionInfo(`[subagent] ${options.agent.agent_id}`);
  sessionManager.appendModelChange(
    options.agent.launch_contract.model.slice(0, options.agent.launch_contract.model.indexOf("/")),
    options.agent.launch_contract.model.slice(options.agent.launch_contract.model.indexOf("/") + 1),
  );
  sessionManager.appendThinkingLevelChange(options.agent.launch_contract.thinking_level);
  for (const message of options.importedMessages) appendImportedMessage(sessionManager, message);

  const sessionFile = sessionManager.getSessionFile();
  if (!sessionFile)
    throw new Error(
      `Minimal subagents session creation: no session file for ${options.agent.agent_id}`,
    );
  if (!existsSync(sessionFile)) {
    const lines = [sessionManager.getHeader(), ...sessionManager.getEntries()]
      .filter((entry) => entry !== null)
      .map((entry) => JSON.stringify(entry))
      .join("\n");
    writeFileSync(sessionFile, `${lines}\n`, "utf8");
    sessionManager = SessionManager.open(sessionFile, options.sessionDir, options.cwd);
  }
  return { sessionFile, sessionId: sessionManager.getSessionId() };
}

/** Build child resources while filtering recursive coordinator loading and honoring project-context omission. */
export function createChildResourceLoaderOptions(
  input: ChildResourceLoaderOptionsInput,
): ConstructorParameters<typeof DefaultResourceLoader>[0] {
  const extensionEntrypoint = canonicalPath(input.extensionEntrypoint);
  const omitProjectContext = input.projectContext === "omit";
  const ordinaryToolNames = new Set(input.ordinaryToolNames ?? []);
  const loadOrdinaryToolExtensions = [...ordinaryToolNames].some(
    (toolName) => !PI_BUILTIN_ORDINARY_TOOL_NAMES.has(toolName),
  );
  return {
    cwd: input.cwd,
    agentDir: input.agentDir,
    settingsManager: input.settingsManager,
    noExtensions: !loadOrdinaryToolExtensions,
    noContextFiles: omitProjectContext,
    noSkills: omitProjectContext,
    noPromptTemplates: omitProjectContext,
    extensionsOverride: loadOrdinaryToolExtensions
      ? (base) => ({
          ...base,
          extensions: base.extensions.filter(
            (extension) =>
              canonicalPath(extension.resolvedPath) !== extensionEntrypoint &&
              [...extension.tools.keys()].some((toolName) => ordinaryToolNames.has(toolName)),
          ),
          errors: base.errors.filter((error) => canonicalPath(error.path) !== extensionEntrypoint),
        })
      : undefined,
    agentsFilesOverride: omitProjectContext ? () => ({ agentsFiles: [] }) : undefined,
    skillsOverride: omitProjectContext
      ? (base) => ({ skills: [], diagnostics: base.diagnostics })
      : undefined,
    promptsOverride: omitProjectContext
      ? (base) => ({ prompts: [], diagnostics: base.diagnostics })
      : undefined,
    systemPromptOverride: omitProjectContext ? () => undefined : undefined,
    appendSystemPromptOverride: (base) =>
      omitProjectContext ? [input.systemPromptBlock] : [...base, input.systemPromptBlock],
  };
}

/** Find durable keyed evidence for exactly-once wait or custom-result delivery. */
export function findDeliveryEvidence(
  entries: readonly unknown[],
  sourceAgentId: string,
  sourceTurnId: string,
): boolean {
  return entries.some((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const candidate = entry as {
      type?: string;
      customType?: string;
      details?: unknown;
      message?: { role?: string; toolName?: string; details?: unknown };
    };
    const details =
      candidate.type === "custom_message" && candidate.customType === "minimal-subagents.result"
        ? candidate.details
        : candidate.type === "message" &&
            candidate.message?.role === "toolResult" &&
            candidate.message.toolName === "subagent_wait"
          ? candidate.message.details
          : undefined;
    if (!details || typeof details !== "object") return false;
    const key = details as { source_agent_id?: string; source_turn_id?: string };
    return key.source_agent_id === sourceAgentId && key.source_turn_id === sourceTurnId;
  });
}

function sumUsage(messages: readonly AgentMessage[]): Usage | undefined {
  return messages.reduce<Usage | undefined>(
    (total, message) =>
      addMinimalSubagentsUsage(total, "usage" in message ? message.usage : undefined),
    undefined,
  );
}

function assistantText(message: AgentMessage | undefined): string {
  if (!message || message.role !== "assistant") return "";
  return message.content
    .filter((content) => content.type === "text")
    .map((content) => content.text)
    .join("\n");
}

class PiChildAgentRuntime implements ChildAgentRuntime {
  private aborted = false;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly session: AgentSession,
    private readonly modelRuntime: ModelRuntime,
    private readonly modelById: ReadonlyMap<string, Model<any>>,
    onSessionActivity?: () => void,
  ) {
    this.unsubscribe = session.subscribe((event) => {
      if (event.type !== "entry_appended") return;
      if (
        event.entry.type === "custom_message" ||
        (event.entry.type === "message" && event.entry.message.role === "toolResult")
      ) {
        onSessionActivity?.();
      }
    });
  }

  get sessionFile(): string {
    const sessionFile = this.session.sessionFile;
    if (!sessionFile)
      throw new Error("Minimal subagents child runtime lost its persistent session file");
    return sessionFile;
  }

  get sessionId(): string {
    return this.session.sessionId;
  }

  get isRunning(): boolean {
    return this.session.isStreaming;
  }

  async runPrompt(
    task: string,
    compact: boolean,
    callerModel: string,
    callerThinkingLevel: ThinkingLevel,
  ): Promise<RuntimeTurnOutcome> {
    if (compact) await this.compactImportedContext(callerModel, callerThinkingLevel);
    return this.captureTurn(() => this.session.prompt(task, { expandPromptTemplates: false }));
  }

  runMessage(message: CoordinatorMessage): Promise<RuntimeTurnOutcome> {
    return this.captureTurn(() =>
      this.session.sendCustomMessage(
        {
          customType: message.customType,
          content: message.content,
          display: true,
          details: message.details,
        },
        { triggerTurn: true, deliverAs: "steer" },
      ),
    );
  }

  async steerCoordinatorMessage(message: CoordinatorMessage): Promise<void> {
    await this.session.sendCustomMessage(
      {
        customType: message.customType,
        content: message.content,
        display: true,
        details: message.details,
      },
      { triggerTurn: true, deliverAs: "steer" },
    );
  }

  async abort(): Promise<void> {
    this.aborted = true;
    await this.session.abort();
  }

  dispose(): void {
    this.unsubscribe();
    this.session.dispose();
  }

  snapshotCommittedMessages(): AgentMessage[] {
    return snapshotCommittedContext(this.session.messages, this.session.isStreaming);
  }

  hasDeliveryEvidence(sourceAgentId: string, sourceTurnId: string): boolean {
    return findDeliveryEvidence(
      this.session.sessionManager.getEntries(),
      sourceAgentId,
      sourceTurnId,
    );
  }

  getUsage(): Usage | undefined {
    return sumUsage(this.session.messages);
  }

  async cloneSession(): Promise<{ sessionFile: string; sessionId: string }> {
    const leafId = this.session.sessionManager.getLeafId();
    if (!leafId)
      throw new Error(`Minimal subagents fork clone: ${this.sessionId} has no child leaf`);
    const sessionFile = this.session.sessionManager.createBranchedSession(leafId);
    if (!sessionFile)
      throw new Error(`Minimal subagents fork clone: ${this.sessionId} is not persistent`);
    return { sessionFile, sessionId: this.session.sessionManager.getSessionId() };
  }

  private async captureTurn(operation: () => Promise<void>): Promise<RuntimeTurnOutcome> {
    const messageStart = this.session.messages.length;
    this.aborted = false;
    try {
      await operation();
    } catch (error) {
      return {
        status: this.aborted ? "cancelled" : "failed",
        output: "",
        error: error instanceof Error ? error.message : String(error),
      };
    }
    const turnMessages = this.session.messages.slice(messageStart);
    const finalAssistant = [...turnMessages]
      .reverse()
      .find((message) => message.role === "assistant");
    if (!finalAssistant || finalAssistant.role !== "assistant") {
      return {
        status: this.aborted ? "cancelled" : "failed",
        output: "",
        error: "No terminal assistant response",
      };
    }
    if (finalAssistant.stopReason === "aborted") {
      return {
        status: "cancelled",
        output: assistantText(finalAssistant),
        error: finalAssistant.errorMessage,
      };
    }
    if (finalAssistant.stopReason === "error") {
      return {
        status: "failed",
        output: assistantText(finalAssistant),
        error: finalAssistant.errorMessage ?? "Provider request failed",
        usage: sumUsage(turnMessages),
      };
    }
    return {
      status: "completed",
      output: assistantText(finalAssistant),
      usage: sumUsage(turnMessages),
    };
  }

  private async compactImportedContext(
    callerModelId: string,
    thinkingLevel: ThinkingLevel,
  ): Promise<void> {
    const contextEntries = this.session.sessionManager.buildContextEntries();
    const cutPoint = findCutPoint(
      contextEntries,
      0,
      contextEntries.length,
      this.session.settingsManager.getCompactionKeepRecentTokens(),
    );
    const firstKeptEntryIndex =
      cutPoint.isSplitTurn && cutPoint.turnStartIndex >= 0
        ? cutPoint.turnStartIndex
        : cutPoint.firstKeptEntryIndex;
    const firstKeptEntry = contextEntries[firstKeptEntryIndex];
    if (!firstKeptEntry || firstKeptEntryIndex <= 0) return;
    const messagesToSummarize = contextEntries
      .slice(0, firstKeptEntryIndex)
      .flatMap((entry) => sessionEntryToContextMessages(entry));
    if (messagesToSummarize.length === 0) return;
    const model = this.modelById.get(callerModelId);
    if (!model)
      throw new Error(
        `Minimal subagents compact context: unavailable caller model ${callerModelId}`,
      );
    const auth = await this.modelRuntime.getAuth(model);
    if (!auth)
      throw new Error(
        `Minimal subagents compact context: authentication unavailable for ${callerModelId}`,
      );
    const summary = await generateSummaryWithUsage(
      messagesToSummarize,
      model,
      this.session.settingsManager.getCompactionReserveTokens(),
      auth.auth.apiKey,
      auth.auth.headers
        ? Object.fromEntries(
            Object.entries(auth.auth.headers).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          )
        : undefined,
      undefined,
      undefined,
      undefined,
      thinkingLevel,
      (streamModel, context, options) =>
        this.modelRuntime.streamSimple(streamModel, context, options),
      auth.env,
      { enabled: false, maxRetries: 0, baseDelayMs: 0 },
    );
    const tokensBefore = contextEntries
      .flatMap((entry) => sessionEntryToContextMessages(entry))
      .reduce((total, message) => total + estimateTokens(message), 0);
    this.session.sessionManager.appendCompaction(
      summary.text,
      firstKeptEntry.id,
      tokensBefore,
      { source: "minimal-subagents", caller_model: callerModelId },
      false,
      summary.usage,
    );
    this.session.agent.state.messages = this.session.sessionManager.buildSessionContext().messages;
  }
}

/** Production Pi SDK session factory used by the process-local coordinator. */
export class PiAgentSessionFactory implements AgentSessionFactory {
  private readonly modelById: Map<string, Model<any>>;
  private readonly eligibleModelIds: Set<string>;
  private readonly availableToolNames: Set<string>;
  private readonly discoveredToolNames = new Map<string, Promise<Set<string>>>();

  constructor(private readonly options: PiAgentSessionFactoryOptions) {
    this.modelById = new Map(
      options.models.map((model) => [`${model.provider}/${model.id}`, model]),
    );
    this.eligibleModelIds = new Set(options.eligibleModelIds);
    this.availableToolNames = new Set(options.availableToolNames);
  }

  createIdentity(
    agent: PersistedAgent,
    importedMessages: AgentMessage[],
  ): PersistedSessionIdentity {
    return createPersistentChildIdentity({
      agent,
      importedMessages,
      cwd: this.options.cwd,
      sessionDir: this.options.sessionDir,
      rootSessionId: this.options.rootSessionId,
    });
  }

  createRuntime(request: RuntimeCreationRequest): Promise<ChildAgentRuntime> {
    return this.openRuntime(request.agent);
  }

  restoreRuntime(agent: PersistedAgent): Promise<ChildAgentRuntime> {
    return this.openRuntime(agent);
  }

  resolveLaunchMissingDependencies(agent: PersistedAgent): Promise<string[]> {
    return this.findMissingDependencies(agent, false);
  }

  resolveRestorationMissingDependencies(agent: PersistedAgent): Promise<string[]> {
    return this.findMissingDependencies(agent, this.options.modelScopeRestricted);
  }

  resolveThinkingLevel(modelId: string, requested: ThinkingLevel): ThinkingLevel {
    const model = this.modelById.get(modelId);
    if (!model) return requested;
    return clampThinkingLevel(model, requested);
  }

  modelSupportsImages(modelId: string): boolean {
    return this.modelById.get(modelId)?.input.includes("image") ?? false;
  }

  async cloneSession(agent: PersistedAgent): Promise<PersistedSessionIdentity> {
    if (!agent.session_file) {
      throw new Error(`Minimal subagents fork clone: ${agent.agent_id} has no source session`);
    }
    const source = SessionManager.open(
      agent.session_file,
      this.options.sessionDir,
      this.options.cwd,
    );
    const leafId = source.getLeafId();
    if (!leafId)
      throw new Error(`Minimal subagents fork clone: ${agent.agent_id} has no child leaf`);
    const sessionFile = source.createBranchedSession(leafId);
    if (!sessionFile)
      throw new Error(`Minimal subagents fork clone: ${agent.agent_id} is not persistent`);
    source.appendCustomEntry("minimal-subagents.fork-clone", {
      source_agent_id: agent.agent_id,
      source_session_id: agent.session_id,
    });
    if (!existsSync(sessionFile)) {
      const lines = [source.getHeader(), ...source.getEntries()]
        .filter((entry) => entry !== null)
        .map((entry) => JSON.stringify(entry))
        .join("\n");
      writeFileSync(sessionFile, `${lines}\n`, "utf8");
    }
    if (!existsSync(sessionFile)) {
      throw new Error(`Minimal subagents fork clone: clone was not flushed for ${agent.agent_id}`);
    }
    return { sessionFile, sessionId: source.getSessionId() };
  }

  async trashSessionFile(sessionFile: string): Promise<void> {
    const trashError = await new Promise<Error | undefined>((resolvePromise) => {
      const trashArguments = sessionFile.startsWith("-") ? ["--", sessionFile] : [sessionFile];
      execFile("trash", trashArguments, (error) => resolvePromise(error ?? undefined));
    });
    if (!trashError || !existsSync(sessionFile)) return;

    try {
      await unlink(sessionFile);
    } catch (error) {
      const unlinkError = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Minimal subagents session deletion failed for ${sessionFile}: ${unlinkError} (trash: ${trashError.message})`,
      );
    }
  }

  private buildChildSystemPrompt(agent: PersistedAgent): string {
    return buildDepthBoundSubagentPrompt(
      agent,
      this.options.maxSubagentDepth ?? DEFAULT_MAX_SUBAGENT_DEPTH,
    );
  }

  private async findMissingDependencies(
    agent: PersistedAgent,
    requireEligibleModel: boolean,
  ): Promise<string[]> {
    const missing: string[] = [];
    if (!this.modelById.has(agent.launch_contract.model)) missing.push(agent.launch_contract.model);
    else if (requireEligibleModel && !this.eligibleModelIds.has(agent.launch_contract.model)) {
      missing.push(agent.launch_contract.model);
    }
    const discoveredTools = await this.discoverChildToolNames(agent);
    for (const toolName of agent.launch_contract.ordinary_tools) {
      if (!discoveredTools.has(toolName)) missing.push(toolName);
    }
    return [...new Set(missing)];
  }

  private discoverChildToolNames(agent: PersistedAgent): Promise<Set<string>> {
    const cacheKey = `${agent.launch_contract.project_context}:${[
      ...agent.launch_contract.ordinary_tools,
    ]
      .sort()
      .join(",")}`;
    const cached = this.discoveredToolNames.get(cacheKey);
    if (cached) return cached;
    const discovery = (async () => {
      const names = new Set(
        [...PI_BUILTIN_ORDINARY_TOOL_NAMES].filter((name) => this.availableToolNames.has(name)),
      );
      const requiresCustomToolDiscovery = agent.launch_contract.ordinary_tools.some(
        (name) => !PI_BUILTIN_ORDINARY_TOOL_NAMES.has(name),
      );
      if (!requiresCustomToolDiscovery) return names;
      const settingsManager = SettingsManager.create(this.options.cwd, this.options.agentDir, {
        projectTrusted: this.options.projectTrusted,
      });
      const resourceLoader = new DefaultResourceLoader(
        createChildResourceLoaderOptions({
          cwd: this.options.cwd,
          agentDir: this.options.agentDir,
          projectContext: agent.launch_contract.project_context,
          extensionEntrypoint: this.options.extensionEntrypoint,
          systemPromptBlock: this.buildChildSystemPrompt(agent),
          ordinaryToolNames: agent.launch_contract.ordinary_tools,
          settingsManager,
        }),
      );
      await resourceLoader.reload();
      for (const extension of resourceLoader.getExtensions().extensions) {
        for (const toolName of extension.tools.keys()) names.add(toolName);
      }
      return names;
    })();
    this.discoveredToolNames.set(cacheKey, discovery);
    return discovery;
  }

  private async openRuntime(agent: PersistedAgent): Promise<ChildAgentRuntime> {
    if (!agent.session_file)
      throw new Error(`Minimal subagents restore: ${agent.agent_id} has no session file`);
    const model = this.modelById.get(agent.launch_contract.model);
    if (!model)
      throw new Error(
        `Minimal subagents restore: model unavailable: ${agent.launch_contract.model}`,
      );
    const settingsManager = SettingsManager.create(this.options.cwd, this.options.agentDir, {
      projectTrusted: this.options.projectTrusted,
    });
    settingsManager.applyOverrides({
      retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
    });
    const resourceLoader = new DefaultResourceLoader(
      createChildResourceLoaderOptions({
        cwd: this.options.cwd,
        agentDir: this.options.agentDir,
        projectContext: agent.launch_contract.project_context,
        extensionEntrypoint: this.options.extensionEntrypoint,
        systemPromptBlock: this.buildChildSystemPrompt(agent),
        ordinaryToolNames: agent.launch_contract.ordinary_tools,
        settingsManager,
      }),
    );
    await resourceLoader.reload();
    const modelRuntime = await ModelRuntime.create({
      authPath: resolve(this.options.agentDir, "auth.json"),
      modelsPath: resolve(this.options.agentDir, "models.json"),
    });
    const sessionManager = SessionManager.open(
      agent.session_file,
      this.options.sessionDir,
      this.options.cwd,
    );
    const coordinatorTools = this.options.getCoordinatorTools(agent.agent_id);
    const allowedToolNames = [
      ...agent.launch_contract.ordinary_tools,
      ...coordinatorTools.map((tool) => tool.name),
    ];
    const { session } = await createAgentSession({
      cwd: this.options.cwd,
      agentDir: this.options.agentDir,
      model,
      thinkingLevel: agent.launch_contract.thinking_level,
      tools: allowedToolNames,
      customTools: coordinatorTools,
      resourceLoader,
      sessionManager,
      settingsManager,
      modelRuntime,
    });
    await session.bindExtensions({ mode: "print" });
    const activeNames = new Set(session.getActiveToolNames());
    const missingTools = allowedToolNames.filter((toolName) => !activeNames.has(toolName));
    if (missingTools.length > 0) {
      session.dispose();
      throw new Error(`Minimal subagents child tool loading failed: ${missingTools.join(", ")}`);
    }
    return new PiChildAgentRuntime(
      session,
      modelRuntime,
      this.modelById,
      this.options.onChildSessionActivity,
    );
  }
}
