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
  type AgentSessionEvent,
  type SessionEntry,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import {
  buildSubagentSystemPrompt,
  snapshotCommittedContext,
} from "./minimal-subagents-context.js";
import {
  canAgentContractSpawn,
  DEFAULT_MAX_SUBAGENT_DEPTH,
  getSubagentDepth,
} from "./minimal-subagents-capabilities.js";
import {
  CHILD_IDENTITY_ENTRY_TYPE,
  FORK_CLONE_ENTRY_TYPE,
  FORK_OWNERSHIP_ENTRY_TYPE,
} from "./minimal-subagents-registry.js";
import {
  ChildSessionIdentityRecordSchema,
  DeliveryEvidenceDetailsSchema,
  ForkCloneProvenanceRecordSchema,
  ForkOwnershipRecordSchema,
  type ChildSessionIdentityRecord,
  type ForkCloneProvenanceRecord,
  type ForkOwnershipRecord,
} from "./minimal-subagents-session-wire.js";
import { addMinimalSubagentsUsage } from "./minimal-subagents-usage.js";
import type {
  AgentSessionFactory,
  ChildAgentRuntime,
  CoordinatorMessage,
  PersistedAgent,
  PersistedSessionIdentity,
  ProjectContextMode,
  RuntimeProfile,
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

/** Moves one verified child session file to trash and reports command unavailability. */
export interface SessionFileTrashCapability {
  moveSessionFile(sessionFile: string): Promise<Error | undefined>;
}

const execFileSessionTrashCapability: SessionFileTrashCapability = {
  moveSessionFile: (sessionFile) =>
    new Promise((resolvePromise) => {
      const trashArguments = sessionFile.startsWith("-") ? ["--", sessionFile] : [sessionFile];
      execFile("trash", trashArguments, (cause) => resolvePromise(cause ?? undefined));
    }),
};

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
  sessionFileTrash?: SessionFileTrashCapability;
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
  // SAFETY: AgentMessage is Pi's broader message union; non-session variants were handled above.
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
  return {
    sessionFile,
    sessionId: sessionManager.getSessionId(),
    sessionLeafId: sessionManager.getLeafId() ?? undefined,
  };
}

function findLatestChildSessionRecord<TRecordSchema extends TSchema>(
  entries: ReturnType<SessionManager["getBranch"]>,
  customType: string,
  schema: TRecordSchema,
): Static<TRecordSchema> | undefined {
  return entries.findLast(
    (
      entry,
    ): entry is Extract<SessionEntry, { type: "custom" }> & {
      data: Static<TRecordSchema>;
    } =>
      entry.type === "custom" && entry.customType === customType && Value.Check(schema, entry.data),
  )?.data;
}

function findLatestForkGeneration(
  entries: ReturnType<SessionManager["getBranch"]>,
): { identity: ChildSessionIdentityRecord; provenance: ForkCloneProvenanceRecord } | undefined {
  for (let provenanceIndex = entries.length - 1; provenanceIndex >= 0; provenanceIndex--) {
    const provenanceEntry = entries[provenanceIndex];
    if (
      !provenanceEntry ||
      provenanceEntry.type !== "custom" ||
      provenanceEntry.customType !== FORK_CLONE_ENTRY_TYPE
    ) {
      continue;
    }
    if (!Value.Check(ForkCloneProvenanceRecordSchema, provenanceEntry.data)) continue;
    const provenance = provenanceEntry.data;
    for (let identityIndex = provenanceIndex - 1; identityIndex >= 0; identityIndex--) {
      const identityEntry = entries[identityIndex];
      if (
        !identityEntry ||
        identityEntry.type !== "custom" ||
        identityEntry.customType !== CHILD_IDENTITY_ENTRY_TYPE
      ) {
        continue;
      }
      if (Value.Check(ChildSessionIdentityRecordSchema, identityEntry.data)) {
        return { identity: identityEntry.data, provenance };
      }
    }
    return undefined;
  }
  return undefined;
}

function findCurrentForkOwnership(
  entries: ReturnType<SessionManager["getBranch"]>,
  cloneSessionId: string,
): ForkOwnershipRecord | undefined {
  return entries.findLast(
    (
      entry,
    ): entry is Extract<SessionEntry, { type: "custom" }> & {
      data: ForkOwnershipRecord;
    } =>
      entry.type === "custom" &&
      entry.customType === FORK_OWNERSHIP_ENTRY_TYPE &&
      Value.Check(ForkOwnershipRecordSchema, entry.data) &&
      entry.data.clone_session_id === cloneSessionId,
  )?.data;
}

function verifyForkCloneProvenance(
  branch: ReturnType<SessionManager["getBranch"]>,
  agent: PersistedAgent,
  sourceRootSessionId: string,
): ForkCloneProvenanceRecord {
  const provenance = findLatestForkGeneration(branch)?.provenance;
  if (
    !provenance ||
    provenance.source_root_session_id !== sourceRootSessionId ||
    provenance.source_agent_id !== agent.agent_id
  ) {
    throw new Error(
      `Minimal subagents session identity mismatch: fork provenance for ${agent.agent_id}`,
    );
  }
  return provenance;
}

/** Verify that a persisted child session path belongs to the expected canonical agent and root. */
export function verifyChildSessionIdentity(
  sessionManager: SessionManager,
  agent: PersistedAgent,
  rootSessionId: string,
): void {
  if (sessionManager.getSessionId() !== agent.session_id) {
    throw new Error(
      `Minimal subagents session identity mismatch: session ID for ${agent.agent_id}`,
    );
  }
  const identityBranch = sessionManager.getBranch(agent.session_leaf_id);
  const generation = findLatestForkGeneration(identityBranch);
  const identity =
    generation?.identity ??
    findLatestChildSessionRecord(
      identityBranch,
      CHILD_IDENTITY_ENTRY_TYPE,
      ChildSessionIdentityRecordSchema,
    );
  if (!identity) {
    throw new Error(`Minimal subagents session identity missing for ${agent.agent_id}`);
  }
  if (
    identity.canonical_agent_id !== agent.agent_id ||
    identity.direct_parent_id !== agent.parent_id ||
    identity.created_at !== agent.created_at
  ) {
    throw new Error(`Minimal subagents session identity mismatch: ownership for ${agent.agent_id}`);
  }
  const ownership = findCurrentForkOwnership(identityBranch, sessionManager.getSessionId());
  if (ownership || identity.original_root_session_id !== rootSessionId) {
    const provenance = generation?.provenance;
    if (
      !ownership ||
      !provenance ||
      ownership.destination_root_session_id !== rootSessionId ||
      ownership.source_root_session_id !== identity.original_root_session_id ||
      ownership.source_root_session_id !== provenance.source_root_session_id ||
      ownership.source_agent_id !== agent.agent_id ||
      ownership.source_agent_id !== provenance.source_agent_id ||
      ownership.source_session_id !== provenance.source_session_id ||
      ownership.clone_session_id !== sessionManager.getSessionId() ||
      ownership.direct_parent_id !== agent.parent_id
    ) {
      throw new Error(
        `Minimal subagents session identity mismatch: root owner for ${agent.agent_id}`,
      );
    }
  }
  if (agent.session_leaf_id && !sessionManager.getEntry(agent.session_leaf_id)) {
    throw new Error(`Minimal subagents session identity mismatch: leaf for ${agent.agent_id}`);
  }
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
  entries: readonly SessionEntry[],
  sourceAgentId: string,
  sourceTurnId: string,
  deliveryId?: string,
): boolean {
  return entries.some((entry) => {
    let details: SessionEntry extends infer TEntry
      ? TEntry extends { details?: infer TDetails }
        ? TDetails
        : undefined
      : undefined;
    let waitToolResult = false;
    if (
      entry.type === "custom_message" &&
      (entry.customType === "minimal-subagents.result" ||
        (deliveryId !== undefined && entry.customType === "minimal-subagents.message"))
    ) {
      details = entry.details;
    } else if (
      entry.type === "message" &&
      entry.message.role === "toolResult" &&
      entry.message.toolName === "subagent_wait"
    ) {
      details = entry.message.details;
      waitToolResult = true;
    } else {
      return false;
    }
    if (!Value.Check(DeliveryEvidenceDetailsSchema, details)) return false;
    if (deliveryId !== undefined) {
      return (
        details.source_agent_id === sourceAgentId &&
        details.source_turn_id === sourceTurnId &&
        (details.delivery_id === deliveryId ||
          details.message_id === deliveryId ||
          details.messages?.some(
            (message) => message.delivery_id === deliveryId || message.message_id === deliveryId,
          ))
      );
    }
    if (waitToolResult && details.event === "message") return false;
    return details.source_agent_id === sourceAgentId && details.source_turn_id === sourceTurnId;
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

/** Collects finalized turn messages without relying on mutable post-compaction session state. */
export class ChildTurnOutcomeCollector {
  private readonly messages: AgentMessage[] = [];
  private readonly unsubscribe: () => void;

  constructor(session: Pick<AgentSession, "subscribe">) {
    this.unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      if (event.type === "message_end") this.messages.push(event.message);
    });
  }

  dispose(): void {
    this.unsubscribe();
  }

  toOutcome(aborted: boolean): RuntimeTurnOutcome {
    const finalAssistant = [...this.messages]
      .reverse()
      .find((message) => message.role === "assistant");
    if (!finalAssistant || finalAssistant.role !== "assistant") {
      return {
        status: aborted ? "cancelled" : "failed",
        output: "",
        error: "No terminal assistant response",
      };
    }
    if (finalAssistant.stopReason === "aborted") {
      return {
        status: "cancelled",
        output: assistantText(finalAssistant),
        error: finalAssistant.errorMessage,
        usage: sumUsage(this.messages),
      };
    }
    if (finalAssistant.stopReason === "error") {
      return {
        status: "failed",
        output: assistantText(finalAssistant),
        error: finalAssistant.errorMessage ?? "Provider request failed",
        usage: sumUsage(this.messages),
      };
    }
    return {
      status: "completed",
      output: assistantText(finalAssistant),
      usage: sumUsage(this.messages),
    };
  }
}

/** Run one child operation while retaining its finalized outcome across compaction. */
export async function captureChildTurnOutcome(
  session: Pick<AgentSession, "subscribe">,
  operation: () => Promise<void>,
  isAborted: () => boolean,
): Promise<RuntimeTurnOutcome> {
  const collector = new ChildTurnOutcomeCollector(session);
  try {
    await operation();
    return collector.toOutcome(isAborted());
  } catch (error) {
    return {
      status: isAborted() ? "cancelled" : "failed",
      output: "",
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    collector.dispose();
  }
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

  get sessionLeafId(): string | undefined {
    return this.session.sessionManager.getLeafId() ?? undefined;
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

  async queueCoordinatorMessage(message: CoordinatorMessage): Promise<void> {
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

  getRuntimeProfile(): RuntimeProfile | undefined {
    const model = this.session.model;
    if (!model) return undefined;
    return {
      model: `${model.provider}/${model.id}`,
      thinking_level: this.session.thinkingLevel,
    };
  }

  snapshotCommittedMessages(): AgentMessage[] {
    return snapshotCommittedContext(this.session.messages, this.session.isStreaming);
  }

  hasDeliveryEvidence(sourceAgentId: string, sourceTurnId: string, deliveryId?: string): boolean {
    return findDeliveryEvidence(
      this.session.sessionManager.getBranch(),
      sourceAgentId,
      sourceTurnId,
      deliveryId,
    );
  }

  getUsage(): Usage | undefined {
    return sumUsage(this.session.messages);
  }

  private async captureTurn(operation: () => Promise<void>): Promise<RuntimeTurnOutcome> {
    this.aborted = false;
    return captureChildTurnOutcome(this.session, operation, () => this.aborted);
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
              (entry): entry is [string, string] => entry[1] !== null,
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
  private readonly sessionFileTrash: SessionFileTrashCapability;

  constructor(private readonly options: PiAgentSessionFactoryOptions) {
    this.modelById = new Map(
      options.models.map((model) => [`${model.provider}/${model.id}`, model]),
    );
    this.eligibleModelIds = new Set(options.eligibleModelIds);
    this.availableToolNames = new Set(options.availableToolNames);
    this.sessionFileTrash = options.sessionFileTrash ?? execFileSessionTrashCapability;
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

  /** Clone one source-owned child leaf with explicit source-root provenance. */
  async cloneSession(agent: PersistedAgent): Promise<PersistedSessionIdentity> {
    return this.cloneSessionOwnedByRoot(agent, this.options.rootSessionId);
  }

  /** Recover one proven selected child leaf after the source process handoff was lost. */
  async cloneForkSourceSession(
    agent: PersistedAgent,
    sourceRootSessionId: string,
  ): Promise<PersistedSessionIdentity> {
    return this.cloneSessionOwnedByRoot(agent, sourceRootSessionId);
  }

  /** Bind one verified fork clone exclusively to this factory's destination root. */
  async adoptForkSessionOwnership(
    agent: PersistedAgent,
    sourceRootSessionId: string,
  ): Promise<PersistedSessionIdentity> {
    if (!agent.session_file || !agent.session_id) {
      throw new Error(`Minimal subagents fork ownership: ${agent.agent_id} has no clone session`);
    }
    const sessionFile = canonicalPath(agent.session_file);
    const sessionManager = SessionManager.open(
      sessionFile,
      this.options.sessionDir,
      this.options.cwd,
    );
    if (sessionManager.getSessionId() !== agent.session_id) {
      throw new Error(
        `Minimal subagents session identity mismatch: session ID for ${agent.agent_id}`,
      );
    }
    const branch = sessionManager.getBranch(agent.session_leaf_id);
    const generation = findLatestForkGeneration(branch);
    const identity =
      generation?.identity ??
      findLatestChildSessionRecord(
        branch,
        CHILD_IDENTITY_ENTRY_TYPE,
        ChildSessionIdentityRecordSchema,
      );
    if (
      !identity ||
      identity.original_root_session_id !== sourceRootSessionId ||
      identity.canonical_agent_id !== agent.agent_id ||
      identity.direct_parent_id !== agent.parent_id ||
      identity.created_at !== agent.created_at
    ) {
      throw new Error(
        `Minimal subagents session identity mismatch: fork provenance for ${agent.agent_id}`,
      );
    }
    const provenance = verifyForkCloneProvenance(branch, agent, sourceRootSessionId);
    const existingOwnership = findCurrentForkOwnership(branch, sessionManager.getSessionId());
    if (existingOwnership) {
      if (
        existingOwnership.source_root_session_id !== sourceRootSessionId ||
        existingOwnership.destination_root_session_id !== this.options.rootSessionId ||
        existingOwnership.source_agent_id !== agent.agent_id ||
        existingOwnership.source_session_id !== provenance.source_session_id ||
        existingOwnership.direct_parent_id !== agent.parent_id
      ) {
        throw new Error(
          `Minimal subagents session identity mismatch: root owner for ${agent.agent_id}`,
        );
      }
    } else {
      sessionManager.appendCustomEntry(FORK_OWNERSHIP_ENTRY_TYPE, {
        version: 1,
        source_root_session_id: sourceRootSessionId,
        destination_root_session_id: this.options.rootSessionId,
        source_agent_id: agent.agent_id,
        source_session_id: provenance.source_session_id,
        clone_session_id: sessionManager.getSessionId(),
        direct_parent_id: agent.parent_id,
      });
    }
    return {
      sessionFile,
      sessionId: sessionManager.getSessionId(),
      sessionLeafId: sessionManager.getLeafId() ?? undefined,
    };
  }

  async trashSession(agent: PersistedAgent): Promise<void> {
    if (!agent.session_file) return;
    const sessionFile = canonicalPath(agent.session_file);
    const sessionManager = SessionManager.open(
      sessionFile,
      this.options.sessionDir,
      this.options.cwd,
    );
    verifyChildSessionIdentity(sessionManager, agent, this.options.rootSessionId);
    const trashError = await this.sessionFileTrash.moveSessionFile(sessionFile);
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

  private async cloneSessionOwnedByRoot(
    agent: PersistedAgent,
    sourceRootSessionId: string,
  ): Promise<PersistedSessionIdentity> {
    if (!agent.session_file || !agent.session_id) {
      throw new Error(`Minimal subagents fork clone: ${agent.agent_id} has no source session`);
    }
    const source = SessionManager.open(
      canonicalPath(agent.session_file),
      this.options.sessionDir,
      this.options.cwd,
    );
    verifyChildSessionIdentity(source, agent, sourceRootSessionId);
    const leafId = agent.session_leaf_id ?? source.getLeafId();
    if (!leafId || !source.getEntry(leafId))
      throw new Error(`Minimal subagents fork clone: ${agent.agent_id} has no child leaf`);
    const sessionFile = source.createBranchedSession(leafId);
    if (!sessionFile)
      throw new Error(`Minimal subagents fork clone: ${agent.agent_id} is not persistent`);
    // createBranchedSession mutates this manager to the new session even when Pi defers
    // writing an identity-only branch until its first assistant response.
    const clone = source;
    clone.appendCustomEntry(CHILD_IDENTITY_ENTRY_TYPE, {
      version: 1,
      original_root_session_id: sourceRootSessionId,
      canonical_agent_id: agent.agent_id,
      direct_parent_id: agent.parent_id,
      created_at: agent.created_at,
    });
    clone.appendCustomEntry(FORK_CLONE_ENTRY_TYPE, {
      version: 1,
      source_root_session_id: sourceRootSessionId,
      source_agent_id: agent.agent_id,
      source_session_id: agent.session_id,
    });
    if (!existsSync(sessionFile)) {
      const lines = [clone.getHeader(), ...clone.getEntries()]
        .filter((entry) => entry !== null)
        .map((entry) => JSON.stringify(entry))
        .join("\n");
      writeFileSync(sessionFile, `${lines}\n`, "utf8");
    }
    if (!existsSync(sessionFile)) {
      throw new Error(`Minimal subagents fork clone: clone was not flushed for ${agent.agent_id}`);
    }
    return {
      sessionFile,
      sessionId: clone.getSessionId(),
      sessionLeafId: clone.getLeafId() ?? undefined,
    };
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

  /** Open one verified persisted Child Agent runtime for launch or restoration. */
  async openRuntime(agent: PersistedAgent): Promise<ChildAgentRuntime> {
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
      canonicalPath(agent.session_file),
      this.options.sessionDir,
      this.options.cwd,
    );
    verifyChildSessionIdentity(sessionManager, agent, this.options.rootSessionId);
    if (agent.session_leaf_id) sessionManager.branch(agent.session_leaf_id);
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
