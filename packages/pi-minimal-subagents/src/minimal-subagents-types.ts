import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";

/** Canonical path-like identity for one persistent subagent. */
export type AgentId = string & { readonly __agentId: unique symbol };

/** Stable identity for one prompt and its complete assistant/tool loop. */
export type TurnId = string & { readonly __turnId: unique symbol };

/** Controls how much committed caller conversation enters a new child session. */
export type SessionContextMode = "inherit" | "compact" | "omit";
/** Controls whether child resource discovery includes project instructions, skills, and prompts. */
export type ProjectContextMode = "inherit" | "omit";
/** Selects inherited, bundled, absent, or explicitly named ordinary child tools. */
export type ToolSelection = "none" | "read" | "modify" | string[];
/** Controls whether a child must work directly or may explicitly fan out one bounded level. */
export type DelegationMode = "none" | "fanout";
/** Reports whether a persistent agent currently owns an active turn. */
export type AgentState = "running" | "idle";
/** Reports whether saved launch dependencies can recreate an agent runtime. */
export type AgentAvailability = "available" | "unavailable";
/** Classifies active and terminal persistent subagent turn outcomes. */
export type TurnStatus = "running" | "completed" | "failed" | "cancelled" | "interrupted";

/** Describes the canonical model and resolved thinking level currently used by a Child Agent. */
export interface RuntimeProfile {
  model: string;
  thinking_level: ThinkingLevel;
}

/** Defines the validated launch contract accepted by the subagent tool. */
export interface SpawnParameters {
  task: string;
  agent_id?: string;
  session_context?: SessionContextMode;
  project_context?: ProjectContextMode;
  model?: string;
  thinking_level?: ThinkingLevel;
  tools?: ToolSelection;
  delegation?: DelegationMode;
}

/** Returns persistent agent and turn identities immediately after launch scheduling. */
export interface SpawnResult {
  agent_id: string;
  turn_id: string;
  status: "running";
}

/** Retains one keyed terminal turn result for waits and durable delivery recovery. */
export interface TurnResult {
  agent_id: string;
  turn_id: string;
  status: Exclude<TurnStatus, "running">;
  output: string;
  error?: string;
  usage?: Usage;
  elapsed_ms?: number;
}

/** Reports whether one direct message was handed to a wait, queued, or failed. */
export type AgentMessageDisposition = "delivered-via-wait" | "queued" | "failed";

export interface AgentMessageResult {
  agent_id: string;
  message_id: string;
  disposition: AgentMessageDisposition;
  error?: string;
}

/** Reports one coordination message returned before the source turn settles. */
export interface WaitMessageResult {
  event: "message";
  agent_id: string;
  turn_id: string;
  message_id: string;
  delivery_id?: string;
  message: string;
}

/** Reports one terminal child turn returned by subagent_wait. */
export type WaitResult = WaitMessageResult | ({ event: "turn" } & TurnResult);

/** Provides bounded hierarchy, usage, and best-known Runtime Profile data for one persistent agent. */
export interface AgentSummary extends RuntimeProfile {
  agent_id: string;
  parent_id: string;
  state: AgentState;
  availability: AgentAvailability;
  active_turn_id?: string;
  latest_turn?: Pick<TurnResult, "turn_id" | "status">;
  tools: string[];
  elapsed_ms?: number;
  latest_activity?: string;
  latest_activity_at?: string;
  task?: string;
  child_count: number;
  children: AgentSummary[];
}

/** Provides bounded recent child conversation text for detailed status. */
export interface RecentAgentMessage {
  source_agent_id: string;
  turn_id: string;
  content: string;
}

/** Extends summary status with launch, dependency, and recent-message diagnostics. */
export interface AgentDetail extends AgentSummary {
  session_file?: string;
  launch_contract: Record<string, unknown>;
  capability_ceiling: string[];
  spawn_entry_id: string;
  recent_messages: RecentAgentMessage[];
  latest_result?: TurnResult;
  missing_dependencies: string[];
  unavailable_reason?: string;
  usage?: Usage;
}

/** Returns either caller-owned direct children or one authorized direct-child detail. */
export type StatusResult = { parent_id: string; agents: AgentSummary[] } | { agent: AgentDetail };

/** Supplies the complete root hierarchy to trusted internal UI and activity projections. */
export type HierarchyStatusResult =
  | { root_id: "root"; agents: AgentSummary[] }
  | { agent: AgentDetail };

/** Reports active turns cancelled without deleting persistent sessions. */
export interface CancelResult {
  agent_id: string;
  recursive: boolean;
  affected_agent_ids: string[];
  cancelled_turn_ids: string[];
}

/** Reports post-order deletion successes, tombstones, trash paths, and partial failures. */
export interface DeleteResult {
  agent_id: string;
  recursive: boolean;
  deleted_agent_ids: string[];
  tombstoned_agent_ids: string[];
  trashed_session_files: string[];
  failures: Array<{ agent_id: string; error: string }>;
}

/** Persists immutable context, model, thinking, and ordinary-tool launch choices. */
export interface LaunchContract extends RuntimeProfile {
  session_context: SessionContextMode;
  project_context: ProjectContextMode;
  tools: ToolSelection | undefined;
  ordinary_tools: string[];
  delegation?: DelegationMode;
}

/** Captures committed caller context and its capability ceiling at spawn time. */
export interface CallerSnapshot {
  messages: AgentMessage[];
  model: string;
  thinkingLevel: ThinkingLevel;
  ordinaryTools: string[];
  capabilityCeiling: string[];
  availableTools: string[];
  spawnEntryId: string;
}

/** Normalizes Pi child runtime completion before persistent turn settlement. */
export interface RuntimeTurnOutcome {
  status: "completed" | "failed" | "cancelled";
  output: string;
  error?: string;
  usage?: Usage;
}

/** Carries keyed conversation-plane content between persistent agent sessions. */
export interface CoordinatorMessage {
  customType: "minimal-subagents.message" | "minimal-subagents.result";
  content: string;
  details: {
    source_agent_id: string;
    destination_agent_id?: string;
    source_turn_id: string;
    message_id: string;
    delivery_id?: string;
    status?: TurnStatus;
    elapsed_ms?: number;
    usage?: Usage;
  };
}

/** Process-local adapter around one SDK-created Pi child session. */
export interface ChildAgentRuntime {
  readonly sessionFile: string;
  readonly sessionId: string;
  readonly sessionLeafId: string | undefined;
  readonly isRunning: boolean;
  runPrompt(
    task: string,
    compact: boolean,
    callerModel: string,
    callerThinkingLevel: ThinkingLevel,
  ): Promise<RuntimeTurnOutcome>;
  runMessage(message: CoordinatorMessage): Promise<RuntimeTurnOutcome>;
  /** Queue one typed coordinator message into the child session. */
  queueCoordinatorMessage(message: CoordinatorMessage): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
  /** Return the live Runtime Profile, or undefined when the SDK session has no model. */
  getRuntimeProfile(): RuntimeProfile | undefined;
  snapshotCommittedMessages(): AgentMessage[];
  hasDeliveryEvidence(sourceAgentId: string, sourceTurnId: string, deliveryId?: string): boolean;
  getUsage(): Usage | undefined;
}

/** Identifies one writable child JSONL session owned by a coordinator root. */
export interface PersistedSessionIdentity {
  sessionFile: string;
  sessionId: string;
  sessionLeafId?: string;
}

/** Combines a persisted agent record with first-launch imported context. */
export interface RuntimeCreationRequest {
  agent: PersistedAgent;
  importedMessages: AgentMessage[];
}

/** Pi-specific session operations injected into the pure coordinator. */
export interface AgentSessionFactory {
  createIdentity(agent: PersistedAgent, importedMessages: AgentMessage[]): PersistedSessionIdentity;
  createRuntime(request: RuntimeCreationRequest): Promise<ChildAgentRuntime>;
  restoreRuntime(agent: PersistedAgent): Promise<ChildAgentRuntime>;
  resolveLaunchMissingDependencies(agent: PersistedAgent): Promise<string[]>;
  resolveRestorationMissingDependencies(agent: PersistedAgent): Promise<string[]>;
  resolveThinkingLevel(modelId: string, requested: ThinkingLevel): ThinkingLevel;
  modelSupportsImages(modelId: string): boolean;
  /** Clone a child leaf owned by the active source root during confirmed shutdown. */
  cloneSession(agent: PersistedAgent): Promise<PersistedSessionIdentity>;
  /** Clone a source-owned leaf recovered from a proven destination branch. */
  cloneForkSourceSession(
    agent: PersistedAgent,
    sourceRootSessionId: string,
  ): Promise<PersistedSessionIdentity>;
  /** Append and verify destination-root ownership for one fork clone. */
  adoptForkSessionOwnership(
    agent: PersistedAgent,
    sourceRootSessionId: string,
  ): Promise<PersistedSessionIdentity>;
  trashSession(agent: PersistedAgent): Promise<void>;
}

/** Abstracts root message delivery and durable delivery-evidence lookup. */
export interface RootConversationEndpoint {
  /** Queue one typed coordinator message into the root conversation. */
  queueCoordinatorMessage(message: CoordinatorMessage): Promise<void>;
  hasDeliveryEvidence(sourceAgentId: string, sourceTurnId: string, deliveryId?: string): boolean;
  /** Report whether automatic delivery can start a new root turn without racing an active wait. */
  isIdle(): boolean;
}

/** Stores root-owned agent identity, launch contract, availability, and latest activity. */
export interface PersistedAgent {
  agent_id: string;
  friendly_id: string;
  parent_id: string;
  created_at: string;
  task?: string;
  latest_activity_at?: string;
  spawn_entry_id: string;
  session_file?: string;
  session_id?: string;
  session_leaf_id?: string;
  clone_error?: string;
  launch_contract: LaunchContract;
  capability_ceiling: string[];
  active_turn_id?: string;
  active_turn_started_at?: string;
  latest_result?: TurnResult;
  availability: AgentAvailability;
  missing_dependencies: string[];
  unavailable_reason?: string;
  recent_messages: RecentAgentMessage[];
  deleted?: boolean;
}

/** Records which conversation path owns one successful terminal result. */
export type DeliveryPath = "wait" | "message";

/** Stores a keyed successful result until destination evidence settles delivery. */
export interface PersistedDelivery {
  source_agent_id: string;
  source_turn_id: string;
  destination_agent_id: string;
  path: DeliveryPath;
  settled: boolean;
  sequence?: number;
  result?: TurnResult;
  error?: string;
}

/** Stores one durable Coordination Message until destination evidence settles it. */
export interface PersistedCoordinationDelivery {
  delivery_id: string;
  sequence: number;
  destination_agent_id: string;
  path: DeliveryPath;
  settled: boolean;
  message: CoordinatorMessage;
  error?: string;
}

/** Checkpoints live agents, tombstones, and only pending delivery-ledger items for one root. */
export interface RegistrySnapshot {
  agents: PersistedAgent[];
  tombstones: string[];
  deliveries: PersistedDelivery[];
  coordination_deliveries?: PersistedCoordinationDelivery[];
  wait_claimed_turns?: string[];
  next_delivery_sequence?: number;
}

/** Clones a registry snapshot while recording the source root session file. */
export interface ForkSnapshot extends RegistrySnapshot {
  /** Canonical Pi root session file from which the selected fork branch originated. */
  source_root_session_file: string;
  /** Root identity that every cloned Child Session provenance record must match. */
  source_root_session_id: string;
}

/** Appends root-owned registry events to the active root conversation branch. */
export interface RegistryWriter {
  readonly rootSessionId: string;
  append(event: import("./minimal-subagents-registry.js").RegistryEventV2): void;
}

/** Describes concise lifecycle notices surfaced through Pi UI notifications. */
export interface CoordinatorNotification {
  type:
    | "spawn"
    | "completion"
    | "failure"
    | "cancellation"
    | "interruption"
    | "restoration"
    | "unavailable"
    | "fork-clone-failure";
  agentId: string;
  message: string;
}

/** Injects sessions, root delivery, registry, delegation depth, delivery grace, and notifications. */
export interface CoordinatorDependencies {
  registry: RegistryWriter;
  sessions: AgentSessionFactory;
  root: RootConversationEndpoint;
  maxSubagentDepth?: number;
  now?: () => Date;
  automaticDeliveryGraceMs?: number;
  notify?: (notification: CoordinatorNotification) => void;
}
