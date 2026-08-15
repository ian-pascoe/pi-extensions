import { COORDINATOR_TOOL_NAMES, THINKING_LEVELS } from "./minimal-subagents-capabilities.js";
import {
  createDeliveryLedger,
  deliveryLedgerSnapshot,
  isDeliveryLedgerTurnClaimed,
  pruneDeliveryLedgerAgents,
  settleCoordinationDelivery,
  settleTerminalDelivery,
  upsertCoordinationDelivery,
  upsertTerminalDelivery,
  WAIT_TERMINAL_RETENTION_LIMIT,
  claimDeliveryLedgerTurn,
  releaseDeliveryLedgerTurn,
  releaseEmptyDeliveryLedgerTurn,
  type DeliveryLedger,
} from "./minimal-subagents-delivery-ledger.js";
import type {
  CoordinatorMessage,
  LaunchContract,
  PersistedAgent,
  PersistedCoordinationDelivery,
  PersistedDelivery,
  RecentAgentMessage,
  RegistrySnapshot,
  TurnResult,
} from "./minimal-subagents-types.js";

/** Names append-only root conversation entries that own the persistent agent Registry. */
export const REGISTRY_ENTRY_TYPE = "minimal-subagents.registry";
/** Names the first custom entry that promotes a child JSONL session to persistent identity. */
export const CHILD_IDENTITY_ENTRY_TYPE = "minimal-subagents.identity";
/** Names destination-root ownership records appended to forked child sessions. */
export const FORK_OWNERSHIP_ENTRY_TYPE = "minimal-subagents.fork-ownership";
/** Names source-session provenance records appended while cloning child sessions. */
export const FORK_CLONE_ENTRY_TYPE = "minimal-subagents.fork-clone";

interface RegistryEventBaseV2 {
  version: 2;
  root_session_id: string;
  timestamp: string;
}

/** Defines unversioned Registry V2 payloads accepted by the write-time event factory. */
export type RegistryEventData =
  | { event: "checkpoint"; snapshot: RegistrySnapshot }
  | { event: "agent-created"; agent: PersistedAgent }
  | { event: "turn-started"; agent_id: string; turn_id: string; started_at: string }
  | {
      event: "turn-settled";
      result: TurnResult;
      settled_at?: string;
      session_leaf_id?: string;
    }
  | { event: "delivery-pending"; delivery: PersistedDelivery }
  | { event: "delivery-settled"; source_agent_id: string; source_turn_id: string; error?: string }
  | {
      event: "delivery-pruned";
      source_agent_id: string;
      source_turn_id: string;
      reason: "retention-limit";
    }
  | { event: "coordination-delivery-pending"; delivery: PersistedCoordinationDelivery }
  | { event: "coordination-delivery-settled"; delivery_id: string; error?: string }
  | { event: "delivery-turn-claimed"; source_agent_id: string; source_turn_id: string }
  | { event: "delivery-turn-released"; source_agent_id: string; source_turn_id: string }
  | {
      event: "agent-message-recorded";
      agent_id: string;
      message: RecentAgentMessage;
      recorded_at: string;
    }
  | { event: "agent-deleted"; agent_ids: string[] };

/** Unites parsed and migrated append-only Registry V2 events. */
export type RegistryEventV2 = RegistryEventBaseV2 & RegistryEventData;

/** Lists stable semantic reasons for rejecting one owned Registry record. */
export type RegistryReplayDiagnosticCode =
  | "invalid-envelope"
  | "unsupported-version"
  | "invalid-event-fields"
  | "invalid-checkpoint"
  | "invalid-agent-hierarchy"
  | "invalid-event-reference"
  | "invalid-delivery-identity"
  | "invalid-delivery-sequence"
  | "invalid-delivery-adjacency";

/** Identifies one malformed or semantically invalid active-branch Registry record. */
export interface RegistryReplayDiagnostic {
  entry_index: number;
  code: RegistryReplayDiagnosticCode;
  message: string;
}

function addRegistryV2Envelope(
  rootSessionId: string,
  timestamp: string,
  data: RegistryEventData,
): RegistryEventV2 {
  // SAFETY: RegistryEventData is a checked discriminated union; TypeScript cannot preserve its member after an object spread intersection.
  return {
    version: 2,
    root_session_id: rootSessionId,
    timestamp,
    ...data,
  } as unknown as RegistryEventV2;
}

/** Add an explicit Registry V2 root-ownership envelope to one append-only event. */
export function createRegistryEvent<TEvent extends RegistryEventData["event"]>(
  rootSessionId: string,
  event: TEvent,
  data: Omit<Extract<RegistryEventData, { event: TEvent }>, "event">,
  timestamp = new Date().toISOString(),
): RegistryEventBaseV2 & Extract<RegistryEventData, { event: TEvent }> {
  // SAFETY: The generic event discriminant selects the corresponding RegistryEventData member.
  const eventData = { event, ...data } as unknown as RegistryEventData;
  if (eventData.event === "checkpoint") {
    const ledger = deliveryLedgerSnapshot(
      createDeliveryLedger({
        deliveries: eventData.snapshot.deliveries,
        coordination_deliveries: eventData.snapshot.coordination_deliveries,
        wait_claimed_turns: eventData.snapshot.wait_claimed_turns,
        next_delivery_sequence: eventData.snapshot.next_delivery_sequence,
      }),
    );
    eventData.snapshot = { ...structuredClone(eventData.snapshot), ...ledger };
  }
  // SAFETY: addRegistryV2Envelope preserves the generic event member supplied by this factory.
  return addRegistryV2Envelope(rootSessionId, timestamp, eventData) as RegistryEventBaseV2 &
    Extract<RegistryEventData, { event: TEvent }>;
}

interface RegistryEntryLike {
  type?: string;
  customType?: string;
  data?: unknown;
}

type UnknownRecord = Record<string, unknown>;

interface ParsedRegistryEvent {
  event?: RegistryEventV2;
  foreignRoot: boolean;
  code?: RegistryReplayDiagnosticCode;
  message?: string;
}

const FRIENDLY_AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const CANONICAL_AGENT_ID_PATTERN =
  /^(?:root\.)?[A-Za-z0-9][A-Za-z0-9_-]{0,63}(?:\.[A-Za-z0-9][A-Za-z0-9_-]{0,63})*$/;
const THINKING_LEVEL_SET = new Set<string>(THINKING_LEVELS);
const TURN_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isOptionalNonEmptyString(value: unknown): boolean {
  return value === undefined || isNonEmptyString(value);
}

function isCanonicalModelId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const separatorIndex = value.indexOf("/");
  return separatorIndex > 0 && separatorIndex < value.length - 1;
}

function isOwnedTurnId(sourceAgentId: string, turnId: string): boolean {
  return turnId.startsWith(`${sourceAgentId}:`) && !turnId.includes("\u0000");
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isUniqueNonEmptyStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every(isNonEmptyString) &&
    // SAFETY: every array element was refined to a non-empty string immediately above.
    new Set(value as string[]).size === value.length
  );
}

function isFiniteNonnegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isSafeSequence(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) < Number.MAX_SAFE_INTEGER
  );
}

function isUsage(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.cost)) return false;
  return (
    [value.input, value.output, value.cacheRead, value.cacheWrite, value.totalTokens].every(
      isFiniteNonnegativeNumber,
    ) &&
    (value.cacheWrite1h === undefined || isFiniteNonnegativeNumber(value.cacheWrite1h)) &&
    (value.reasoning === undefined || isFiniteNonnegativeNumber(value.reasoning)) &&
    [
      value.cost.input,
      value.cost.output,
      value.cost.cacheRead,
      value.cost.cacheWrite,
      value.cost.total,
    ].every(isFiniteNonnegativeNumber)
  );
}

function isRecentAgentMessage(value: unknown): value is RecentAgentMessage {
  return (
    isRecord(value) &&
    isNonEmptyString(value.source_agent_id) &&
    isNonEmptyString(value.turn_id) &&
    typeof value.content === "string"
  );
}

function isTurnResult(value: unknown): value is TurnResult {
  return (
    isRecord(value) &&
    isNonEmptyString(value.agent_id) &&
    isNonEmptyString(value.turn_id) &&
    TURN_STATUSES.has(String(value.status)) &&
    typeof value.output === "string" &&
    isOptionalString(value.error) &&
    (value.usage === undefined || isUsage(value.usage)) &&
    (value.elapsed_ms === undefined || isFiniteNonnegativeNumber(value.elapsed_ms))
  );
}

const COORDINATOR_TOOL_NAME_SET = new Set<string>(COORDINATOR_TOOL_NAMES);

function excludesCoordinatorToolNames(toolNames: readonly string[]): boolean {
  return toolNames.every((toolName) => !COORDINATOR_TOOL_NAME_SET.has(toolName));
}

function isToolSelection(value: unknown): boolean {
  return (
    value === undefined ||
    value === "none" ||
    value === "read" ||
    value === "modify" ||
    (isUniqueNonEmptyStringArray(value) && excludesCoordinatorToolNames(value))
  );
}

function isLaunchContract(value: unknown): value is LaunchContract {
  return (
    isRecord(value) &&
    ["inherit", "compact", "omit"].includes(String(value.session_context)) &&
    ["inherit", "omit"].includes(String(value.project_context)) &&
    isCanonicalModelId(value.model) &&
    THINKING_LEVEL_SET.has(String(value.thinking_level)) &&
    isToolSelection(value.tools) &&
    isUniqueNonEmptyStringArray(value.ordinary_tools) &&
    excludesCoordinatorToolNames(value.ordinary_tools) &&
    (value.delegation === undefined || value.delegation === "none" || value.delegation === "fanout")
  );
}

function isPersistedAgent(value: unknown, version: 1 | 2): value is PersistedAgent {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.agent_id) ||
    value.agent_id === "root" ||
    !CANONICAL_AGENT_ID_PATTERN.test(value.agent_id) ||
    !isNonEmptyString(value.friendly_id) ||
    value.friendly_id === "root" ||
    value.friendly_id === "parent" ||
    !FRIENDLY_AGENT_ID_PATTERN.test(value.friendly_id) ||
    !isNonEmptyString(value.parent_id) ||
    !isIsoTimestamp(value.created_at) ||
    !isNonEmptyString(value.spawn_entry_id) ||
    !isLaunchContract(value.launch_contract) ||
    !isUniqueNonEmptyStringArray(value.capability_ceiling) ||
    (value.availability !== "available" && value.availability !== "unavailable") ||
    !isUniqueNonEmptyStringArray(value.missing_dependencies) ||
    !Array.isArray(value.recent_messages) ||
    !value.recent_messages.every(isRecentAgentMessage)
  ) {
    return false;
  }
  if (
    !isOptionalString(value.task) ||
    (value.latest_activity_at !== undefined && !isIsoTimestamp(value.latest_activity_at)) ||
    !isOptionalNonEmptyString(value.session_file) ||
    !isOptionalNonEmptyString(value.session_id) ||
    !isOptionalNonEmptyString(value.session_leaf_id) ||
    !isOptionalNonEmptyString(value.clone_error) ||
    !isOptionalNonEmptyString(value.active_turn_id) ||
    (value.active_turn_started_at !== undefined && !isIsoTimestamp(value.active_turn_started_at)) ||
    (value.latest_result !== undefined && !isTurnResult(value.latest_result)) ||
    !isOptionalNonEmptyString(value.unavailable_reason) ||
    (value.deleted !== undefined && typeof value.deleted !== "boolean")
  ) {
    return false;
  }
  if ((value.active_turn_id === undefined) !== (value.active_turn_started_at === undefined))
    return false;
  if ((value.session_file === undefined) !== (value.session_id === undefined)) return false;
  if (version === 2) {
    if (value.session_leaf_id !== undefined && value.session_id === undefined) return false;
    if (value.session_id !== undefined && value.session_leaf_id === undefined) return false;
  }
  if (value.clone_error !== undefined && value.availability !== "unavailable") return false;
  if (!excludesCoordinatorToolNames(value.capability_ceiling)) return false;
  const capabilityCeiling = new Set(value.capability_ceiling);
  if (
    value.launch_contract.ordinary_tools.length !== capabilityCeiling.size ||
    value.launch_contract.ordinary_tools.some((toolName) => !capabilityCeiling.has(toolName))
  )
    return false;
  if (
    typeof value.active_turn_id === "string" &&
    !isOwnedTurnId(value.agent_id, value.active_turn_id)
  )
    return false;
  const expectedAgentId =
    value.parent_id === "root"
      ? [value.friendly_id, `root.${value.friendly_id}`]
      : [`${value.parent_id}.${value.friendly_id}`];
  if (!expectedAgentId.includes(value.agent_id)) return false;
  if (
    value.latest_result !== undefined &&
    (value.latest_result.agent_id !== value.agent_id ||
      !isOwnedTurnId(value.agent_id, value.latest_result.turn_id) ||
      value.latest_result.turn_id === value.active_turn_id)
  ) {
    return false;
  }
  return true;
}

function isPersistedDelivery(value: unknown, version: 1 | 2): value is PersistedDelivery {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.source_agent_id) ||
    !isNonEmptyString(value.source_turn_id) ||
    !isNonEmptyString(value.destination_agent_id) ||
    (value.path !== "wait" && value.path !== "message") ||
    typeof value.settled !== "boolean" ||
    (value.error !== undefined && typeof value.error !== "string") ||
    (value.result !== undefined && !isTurnResult(value.result))
  ) {
    return false;
  }
  if (
    version === 2 &&
    (!isSafeSequence(value.sequence) || value.result === undefined || value.settled !== false)
  )
    return false;
  return value.sequence === undefined || isSafeSequence(value.sequence);
}

function isCoordinatorMessage(value: unknown): value is CoordinatorMessage {
  if (!isRecord(value) || !isRecord(value.details)) return false;
  return (
    value.customType === "minimal-subagents.message" &&
    typeof value.content === "string" &&
    isNonEmptyString(value.details.source_agent_id) &&
    isNonEmptyString(value.details.destination_agent_id) &&
    isNonEmptyString(value.details.source_turn_id) &&
    isNonEmptyString(value.details.message_id) &&
    isNonEmptyString(value.details.delivery_id) &&
    value.details.status === undefined &&
    value.details.elapsed_ms === undefined &&
    value.details.usage === undefined
  );
}

function isCoordinationDelivery(
  value: unknown,
  version: 1 | 2,
): value is PersistedCoordinationDelivery {
  return (
    isRecord(value) &&
    isNonEmptyString(value.delivery_id) &&
    isSafeSequence(value.sequence) &&
    isNonEmptyString(value.destination_agent_id) &&
    (value.path === "wait" || value.path === "message") &&
    typeof value.settled === "boolean" &&
    (value.error === undefined || typeof value.error === "string") &&
    isCoordinatorMessage(value.message) &&
    (version === 1 || value.settled === false)
  );
}

function hasValidAgentHierarchy(agents: readonly PersistedAgent[]): boolean {
  const byId = new Map<string, PersistedAgent>();
  for (const agent of agents) {
    if (byId.has(agent.agent_id)) return false;
    byId.set(agent.agent_id, agent);
  }
  for (const agent of agents) {
    const visited = new Set<string>([agent.agent_id]);
    let parentId = agent.parent_id;
    while (parentId !== "root") {
      if (visited.has(parentId)) return false;
      visited.add(parentId);
      const parent = byId.get(parentId);
      if (!parent) return false;
      parentId = parent.parent_id;
    }
  }
  return true;
}

function areAdjacentAgents(
  sourceAgentId: string,
  destinationAgentId: string,
  agentsById: ReadonlyMap<string, PersistedAgent>,
): boolean {
  if (sourceAgentId === destinationAgentId) return false;
  const source = sourceAgentId === "root" ? undefined : agentsById.get(sourceAgentId);
  const destination =
    destinationAgentId === "root" ? undefined : agentsById.get(destinationAgentId);
  if (sourceAgentId === "root") return destination?.parent_id === "root";
  if (destinationAgentId === "root") return source?.parent_id === "root";
  if (!source || !destination) return false;
  return (
    source.parent_id === destinationAgentId ||
    destination.parent_id === sourceAgentId ||
    source.parent_id === destination.parent_id
  );
}

function validateDeliveryIdentity(delivery: PersistedDelivery, version: 1 | 2): string | undefined {
  if (!isOwnedTurnId(delivery.source_agent_id, delivery.source_turn_id))
    return "terminal source_turn_id must belong to source_agent_id";
  if (delivery.result) {
    if (delivery.result.agent_id !== delivery.source_agent_id)
      return "terminal result agent_id must equal delivery source_agent_id";
    if (delivery.result.turn_id !== delivery.source_turn_id)
      return "terminal result turn_id must equal delivery source_turn_id";
    if (delivery.result.status !== "completed")
      return "pending terminal delivery result must be completed";
  } else if (version === 2) {
    return "Registry V2 terminal delivery must retain its result";
  }
  return undefined;
}

function validateCoordinationIdentity(delivery: PersistedCoordinationDelivery): string | undefined {
  const details = delivery.message.details;
  if (!isOwnedTurnId(details.source_agent_id, details.source_turn_id))
    return "Coordination Message source_turn_id must belong to source_agent_id";
  if (delivery.delivery_id !== `message:${details.message_id}`)
    return "Coordination delivery_id must equal message:<message_id>";
  if (details.delivery_id !== delivery.delivery_id)
    return "Coordination message delivery_id must equal delivery delivery_id";
  if (details.destination_agent_id !== delivery.destination_agent_id)
    return "Coordination message destination_agent_id must equal delivery destination_agent_id";
  return undefined;
}

function isObservableSourceTurn(
  agent: PersistedAgent,
  sourceTurnId: string,
  deliveries: readonly PersistedDelivery[],
  coordinationDeliveries: readonly PersistedCoordinationDelivery[],
): boolean {
  return (
    agent.active_turn_id === sourceTurnId ||
    agent.latest_result?.turn_id === sourceTurnId ||
    deliveries.some(
      (delivery) =>
        !delivery.settled &&
        delivery.source_agent_id === agent.agent_id &&
        delivery.source_turn_id === sourceTurnId,
    ) ||
    coordinationDeliveries.some(
      (delivery) =>
        !delivery.settled &&
        delivery.message.details.source_agent_id === agent.agent_id &&
        delivery.message.details.source_turn_id === sourceTurnId,
    )
  );
}

function validateRegistrySnapshot(
  value: unknown,
  version: 1 | 2,
): { snapshot?: RegistrySnapshot; code?: RegistryReplayDiagnosticCode; message?: string } {
  if (!isRecord(value))
    return { code: "invalid-checkpoint", message: "snapshot must be an object" };
  if (
    !Array.isArray(value.agents) ||
    !value.agents.every((agent) => isPersistedAgent(agent, version))
  )
    return { code: "invalid-checkpoint", message: "snapshot agents are incomplete or invalid" };
  // SAFETY: every agents element was fully parsed by isPersistedAgent above.
  const agents = value.agents as PersistedAgent[];
  if (!hasValidAgentHierarchy(agents))
    return { code: "invalid-agent-hierarchy", message: "snapshot agent hierarchy is invalid" };
  if (!isUniqueNonEmptyStringArray(value.tombstones))
    return { code: "invalid-checkpoint", message: "snapshot tombstones must be unique agent IDs" };
  // SAFETY: isUniqueNonEmptyStringArray parsed every tombstone above.
  const tombstones = value.tombstones as string[];
  if (
    tombstones.some((agentId) => agentId === "root" || !CANONICAL_AGENT_ID_PATTERN.test(agentId))
  ) {
    return { code: "invalid-agent-hierarchy", message: "tombstone agent ID is not canonical" };
  }
  if (agents.some((agent) => agent.deleted === true)) {
    return { code: "invalid-agent-hierarchy", message: "live snapshot agents cannot be deleted" };
  }
  const agentIds = new Set(agents.map((agent) => agent.agent_id));
  if (tombstones.some((agentId) => agentIds.has(agentId)))
    return { code: "invalid-agent-hierarchy", message: "live agents cannot also be tombstoned" };
  if (
    !Array.isArray(value.deliveries) ||
    !value.deliveries.every((delivery) => isPersistedDelivery(delivery, version))
  ) {
    return { code: "invalid-checkpoint", message: "snapshot terminal deliveries are invalid" };
  }
  if (version === 2 && value.coordination_deliveries === undefined) {
    return {
      code: "invalid-checkpoint",
      message: "Registry V2 checkpoint must include coordination_deliveries",
    };
  }
  if (
    value.coordination_deliveries !== undefined &&
    (!Array.isArray(value.coordination_deliveries) ||
      !value.coordination_deliveries.every((delivery) => isCoordinationDelivery(delivery, version)))
  ) {
    return { code: "invalid-checkpoint", message: "snapshot Coordination Messages are invalid" };
  }
  if (version === 2 && value.wait_claimed_turns === undefined) {
    return {
      code: "invalid-checkpoint",
      message: "Registry V2 checkpoint must include wait_claimed_turns",
    };
  }
  if (
    value.wait_claimed_turns !== undefined &&
    (!isUniqueNonEmptyStringArray(value.wait_claimed_turns) ||
      value.wait_claimed_turns.some(
        (key) => key.indexOf("\u0000") <= 0 || key.indexOf("\u0000") !== key.lastIndexOf("\u0000"),
      ))
  ) {
    return { code: "invalid-checkpoint", message: "snapshot wait claims are invalid" };
  }
  if (version === 2 && value.next_delivery_sequence === undefined) {
    return {
      code: "invalid-delivery-sequence",
      message: "Registry V2 checkpoint must include next_delivery_sequence",
    };
  }
  if (value.next_delivery_sequence !== undefined && !isSafeSequence(value.next_delivery_sequence)) {
    return {
      code: "invalid-delivery-sequence",
      message: "next_delivery_sequence must be a positive safe integer",
    };
  }

  const agentsById = new Map(agents.map((agent) => [agent.agent_id, agent]));
  // SAFETY: every terminal and Coordination Message item passed its version-aware parser above.
  const deliveries = value.deliveries as PersistedDelivery[];
  const coordinationDeliveries = (value.coordination_deliveries ??
    []) as PersistedCoordinationDelivery[];
  for (const agent of agents) {
    if (version === 2 && agent.recent_messages.length > 20) {
      return {
        code: "invalid-checkpoint",
        message: "agent recent_messages exceeds the 20-item projection limit",
      };
    }
    for (const message of agent.recent_messages) {
      if (
        !isOwnedTurnId(message.source_agent_id, message.turn_id) ||
        !areAdjacentAgents(message.source_agent_id, agent.agent_id, agentsById)
      ) {
        return {
          code: "invalid-delivery-adjacency",
          message: "recent message endpoints and source turn must identify adjacent agents",
        };
      }
    }
  }
  const terminalDeliveryKeys = deliveries.map(
    (delivery) => `${delivery.source_agent_id}\u0000${delivery.source_turn_id}`,
  );
  if (new Set(terminalDeliveryKeys).size !== terminalDeliveryKeys.length) {
    return {
      code: "invalid-delivery-identity",
      message: "terminal delivery source-turn identities must be unique",
    };
  }
  const coordinationDeliveryIds = coordinationDeliveries.map((delivery) => delivery.delivery_id);
  if (new Set(coordinationDeliveryIds).size !== coordinationDeliveryIds.length) {
    return {
      code: "invalid-delivery-identity",
      message: "Coordination Message delivery IDs must be unique",
    };
  }
  const waitTerminalCounts = new Map<string, number>();
  for (const delivery of deliveries) {
    if (delivery.path === "wait") {
      const count = (waitTerminalCounts.get(delivery.source_agent_id) ?? 0) + 1;
      waitTerminalCounts.set(delivery.source_agent_id, count);
      if (version === 2 && count > WAIT_TERMINAL_RETENTION_LIMIT) {
        return {
          code: "invalid-checkpoint",
          message: `wait-only terminal retention exceeds ${WAIT_TERMINAL_RETENTION_LIMIT} items for one source agent`,
        };
      }
    }
    const identityError = validateDeliveryIdentity(delivery, version);
    if (identityError) return { code: "invalid-delivery-identity", message: identityError };
    if (!isOwnedTurnId(delivery.source_agent_id, delivery.source_turn_id)) {
      return {
        code: "invalid-delivery-identity",
        message: "terminal source_turn_id must belong to source_agent_id",
      };
    }
    const source = agentsById.get(delivery.source_agent_id);
    if (!source)
      return { code: "invalid-event-reference", message: "terminal delivery source is not live" };
    if (source.parent_id !== delivery.destination_agent_id) {
      return {
        code: "invalid-delivery-adjacency",
        message: "terminal delivery destination must be the source agent direct parent",
      };
    }
  }
  for (const delivery of coordinationDeliveries) {
    const identityError = validateCoordinationIdentity(delivery);
    if (identityError) return { code: "invalid-delivery-identity", message: identityError };
    if (
      !isOwnedTurnId(
        delivery.message.details.source_agent_id,
        delivery.message.details.source_turn_id,
      )
    ) {
      return {
        code: "invalid-delivery-identity",
        message: "Coordination Message source_turn_id must belong to source_agent_id",
      };
    }
    if (
      !areAdjacentAgents(
        delivery.message.details.source_agent_id,
        delivery.destination_agent_id,
        agentsById,
      )
    ) {
      return {
        code: "invalid-delivery-adjacency",
        message: "Coordination Message endpoints must be adjacent live agents",
      };
    }
  }
  const sequences = [
    ...deliveries.flatMap((delivery) =>
      delivery.sequence === undefined ? [] : [delivery.sequence],
    ),
    ...coordinationDeliveries.map((delivery) => delivery.sequence),
  ];
  if (new Set(sequences).size !== sequences.length)
    return { code: "invalid-delivery-sequence", message: "delivery sequences must be unique" };
  if (
    value.next_delivery_sequence !== undefined &&
    sequences.some((sequence) => sequence >= Number(value.next_delivery_sequence))
  ) {
    return {
      code: "invalid-delivery-sequence",
      message: "next_delivery_sequence must be greater than every retained sequence",
    };
  }
  // SAFETY: wait_claimed_turns was parsed as a unique non-empty string array above.
  for (const key of (value.wait_claimed_turns ?? []) as string[]) {
    const separatorIndex = key.indexOf("\u0000");
    const sourceAgentId = key.slice(0, separatorIndex);
    const sourceTurnId = key.slice(separatorIndex + 1);
    const sourceAgent = agentsById.get(sourceAgentId);
    if (
      !sourceAgent ||
      !isOwnedTurnId(sourceAgentId, sourceTurnId) ||
      !isObservableSourceTurn(sourceAgent, sourceTurnId, deliveries, coordinationDeliveries)
    ) {
      return {
        code: "invalid-event-reference",
        message: "wait claim must reference an active, latest, or retained source turn",
      };
    }
  }

  // SAFETY: Every RegistrySnapshot field and cross-field invariant was checked above.
  const snapshot = structuredClone(value) as unknown as RegistrySnapshot;
  if (version === 1) {
    for (const agent of snapshot.agents) {
      if (!agent.session_id) agent.session_leaf_id = undefined;
      agent.recent_messages = agent.recent_messages.slice(-20);
    }
  }
  const normalizedLedger = deliveryLedgerSnapshot(
    createDeliveryLedger({
      deliveries: snapshot.deliveries,
      coordination_deliveries: snapshot.coordination_deliveries,
      wait_claimed_turns: snapshot.wait_claimed_turns,
      next_delivery_sequence: snapshot.next_delivery_sequence,
    }),
  );
  snapshot.deliveries = normalizedLedger.deliveries;
  snapshot.coordination_deliveries = normalizedLedger.coordination_deliveries;
  snapshot.wait_claimed_turns = normalizedLedger.wait_claimed_turns;
  snapshot.next_delivery_sequence = normalizedLedger.next_delivery_sequence;
  return { snapshot };
}

function invalidParsedEvent(
  code: RegistryReplayDiagnosticCode,
  message: string,
): ParsedRegistryEvent {
  return { foreignRoot: false, code, message };
}

function parseRegistryEventRecord(value: unknown, rootSessionId: string): ParsedRegistryEvent {
  if (!isRecord(value)) return invalidParsedEvent("invalid-envelope", "record must be an object");
  if (typeof value.root_session_id === "string" && value.root_session_id !== rootSessionId) {
    return { foreignRoot: true };
  }
  if (!isNonEmptyString(value.root_session_id) || !isIsoTimestamp(value.timestamp)) {
    return invalidParsedEvent(
      "invalid-envelope",
      "root_session_id and timestamp must be valid strings",
    );
  }
  if (value.version !== 1 && value.version !== 2) {
    return invalidParsedEvent("unsupported-version", "Registry version must be 1 or 2");
  }
  if (typeof value.event !== "string")
    return invalidParsedEvent("invalid-event-fields", "event discriminant must be a string");
  const version = value.version;
  let data: RegistryEventData;
  switch (value.event) {
    case "checkpoint": {
      const parsed = validateRegistrySnapshot(value.snapshot, version);
      if (!parsed.snapshot)
        return invalidParsedEvent(
          parsed.code ?? "invalid-checkpoint",
          parsed.message ?? "invalid snapshot",
        );
      data = { event: "checkpoint", snapshot: parsed.snapshot };
      break;
    }
    case "agent-created":
      if (
        !isPersistedAgent(value.agent, version) ||
        (version === 2 && value.agent.recent_messages.length > 20)
      )
        return invalidParsedEvent("invalid-event-fields", "agent-created agent is incomplete");
      data = { event: "agent-created", agent: structuredClone(value.agent) };
      if (version === 1) {
        if (!data.agent.session_id) data.agent.session_leaf_id = undefined;
        data.agent.recent_messages = data.agent.recent_messages.slice(-20);
      }
      break;
    case "turn-started":
      if (
        !isNonEmptyString(value.agent_id) ||
        !isNonEmptyString(value.turn_id) ||
        !isOwnedTurnId(value.agent_id, value.turn_id) ||
        !isIsoTimestamp(value.started_at)
      ) {
        return invalidParsedEvent("invalid-event-fields", "turn-started fields are invalid");
      }
      data = {
        event: "turn-started",
        agent_id: value.agent_id,
        turn_id: value.turn_id,
        started_at: value.started_at,
      };
      break;
    case "turn-settled":
      if (
        !isTurnResult(value.result) ||
        !isOwnedTurnId(value.result.agent_id, value.result.turn_id) ||
        (value.settled_at !== undefined && !isIsoTimestamp(value.settled_at)) ||
        !isOptionalNonEmptyString(value.session_leaf_id)
      ) {
        return invalidParsedEvent("invalid-event-fields", "turn-settled fields are invalid");
      }
      data = { event: "turn-settled", result: structuredClone(value.result) };
      if (typeof value.settled_at === "string") data.settled_at = value.settled_at;
      if (typeof value.session_leaf_id === "string") data.session_leaf_id = value.session_leaf_id;
      break;
    case "delivery-pending": {
      if (!isPersistedDelivery(value.delivery, version))
        return invalidParsedEvent("invalid-event-fields", "terminal delivery fields are invalid");
      const identityError = validateDeliveryIdentity(value.delivery, version);
      if (identityError) return invalidParsedEvent("invalid-delivery-identity", identityError);
      data = { event: "delivery-pending", delivery: structuredClone(value.delivery) };
      break;
    }
    case "delivery-settled":
      if (
        !isNonEmptyString(value.source_agent_id) ||
        !isNonEmptyString(value.source_turn_id) ||
        !isOwnedTurnId(value.source_agent_id, value.source_turn_id) ||
        !isOptionalString(value.error)
      ) {
        return invalidParsedEvent("invalid-event-fields", "delivery-settled fields are invalid");
      }
      data = {
        event: "delivery-settled",
        source_agent_id: value.source_agent_id,
        source_turn_id: value.source_turn_id,
      };
      if (typeof value.error === "string") data.error = value.error;
      break;
    case "delivery-pruned":
      if (
        version !== 2 ||
        !isNonEmptyString(value.source_agent_id) ||
        !isNonEmptyString(value.source_turn_id) ||
        !isOwnedTurnId(value.source_agent_id, value.source_turn_id) ||
        value.reason !== "retention-limit"
      ) {
        return invalidParsedEvent("invalid-event-fields", "delivery-pruned fields are invalid");
      }
      data = {
        event: "delivery-pruned",
        source_agent_id: value.source_agent_id,
        source_turn_id: value.source_turn_id,
        reason: "retention-limit",
      };
      break;
    case "coordination-delivery-pending": {
      if (!isCoordinationDelivery(value.delivery, version))
        return invalidParsedEvent(
          "invalid-event-fields",
          "Coordination Message delivery fields are invalid",
        );
      const identityError = validateCoordinationIdentity(value.delivery);
      if (identityError) return invalidParsedEvent("invalid-delivery-identity", identityError);
      data = {
        event: "coordination-delivery-pending",
        delivery: structuredClone(value.delivery),
      };
      break;
    }
    case "coordination-delivery-settled":
      if (!isNonEmptyString(value.delivery_id) || !isOptionalString(value.error)) {
        return invalidParsedEvent(
          "invalid-event-fields",
          "coordination-delivery-settled fields are invalid",
        );
      }
      data = { event: "coordination-delivery-settled", delivery_id: value.delivery_id };
      if (typeof value.error === "string") data.error = value.error;
      break;
    case "delivery-turn-claimed":
    case "delivery-turn-released":
      if (
        !isNonEmptyString(value.source_agent_id) ||
        !isNonEmptyString(value.source_turn_id) ||
        !isOwnedTurnId(value.source_agent_id, value.source_turn_id)
      ) {
        return invalidParsedEvent("invalid-event-fields", `${value.event} fields are invalid`);
      }
      data = {
        event: value.event,
        source_agent_id: value.source_agent_id,
        source_turn_id: value.source_turn_id,
      };
      break;
    case "agent-message-recorded":
      if (
        !isNonEmptyString(value.agent_id) ||
        !isRecentAgentMessage(value.message) ||
        !isOwnedTurnId(value.message.source_agent_id, value.message.turn_id) ||
        (version === 2 && !isIsoTimestamp(value.recorded_at))
      ) {
        return invalidParsedEvent("invalid-event-fields", "agent activity fields are invalid");
      }
      data = {
        event: "agent-message-recorded",
        agent_id: value.agent_id,
        message: structuredClone(value.message),
        recorded_at: version === 1 ? value.timestamp : String(value.recorded_at),
      };
      break;
    case "agent-deleted":
      if (
        !isUniqueNonEmptyStringArray(value.agent_ids) ||
        value.agent_ids.length === 0 ||
        value.agent_ids.some(
          (agentId) => agentId === "root" || !CANONICAL_AGENT_ID_PATTERN.test(agentId),
        )
      ) {
        return invalidParsedEvent(
          "invalid-event-fields",
          "agent-deleted IDs must be unique canonical non-root agent IDs",
        );
      }
      data = { event: "agent-deleted", agent_ids: [...value.agent_ids] };
      break;
    default:
      return invalidParsedEvent("invalid-event-fields", `unknown Registry event: ${value.event}`);
  }
  return {
    foreignRoot: false,
    event: addRegistryV2Envelope(rootSessionId, value.timestamp, data),
  };
}

/** Parse one V1 or V2 Registry payload into the current V2 representation without throwing. */
export function parseRegistryEvent(
  value: unknown,
  rootSessionId: string,
): RegistryEventV2 | undefined {
  return parseRegistryEventRecord(value, rootSessionId).event;
}

function reportDiagnostic(
  diagnostics: RegistryReplayDiagnostic[],
  entryIndex: number,
  code: RegistryReplayDiagnosticCode,
  message: string,
): void {
  diagnostics.push({ entry_index: entryIndex, code, message });
}

interface ReplayDeliverySequenceState {
  readonly terminalSequences: Map<string, number>;
  readonly coordinationSequences: Map<string, number>;
  highWaterMark: number;
}

function terminalDeliveryIdentity(delivery: PersistedDelivery): string {
  return `${delivery.source_agent_id}\u0000${delivery.source_turn_id}`;
}

function observeTerminalEventSequence(
  state: ReplayDeliverySequenceState,
  delivery: PersistedDelivery,
): PersistedDelivery | undefined {
  const identity = terminalDeliveryIdentity(delivery);
  const existingSequence = state.terminalSequences.get(identity);
  if (existingSequence !== undefined) {
    if (delivery.sequence !== undefined && delivery.sequence !== existingSequence) return undefined;
    return { ...delivery, sequence: existingSequence };
  }
  const sequence = delivery.sequence ?? state.highWaterMark + 1;
  if (
    !isSafeSequence(sequence) ||
    sequence >= Number.MAX_SAFE_INTEGER ||
    sequence <= state.highWaterMark
  )
    return undefined;
  state.terminalSequences.set(identity, sequence);
  state.highWaterMark = sequence;
  return { ...delivery, sequence };
}

function observeCoordinationEventSequence(
  state: ReplayDeliverySequenceState,
  delivery: PersistedCoordinationDelivery,
): PersistedCoordinationDelivery | undefined {
  const existingSequence = state.coordinationSequences.get(delivery.delivery_id);
  if (existingSequence !== undefined) {
    return delivery.sequence === existingSequence ? delivery : undefined;
  }
  if (delivery.sequence >= Number.MAX_SAFE_INTEGER || delivery.sequence <= state.highWaterMark)
    return undefined;
  state.coordinationSequences.set(delivery.delivery_id, delivery.sequence);
  state.highWaterMark = delivery.sequence;
  return delivery;
}

function validateEventAgentReference(
  agentId: string,
  agents: ReadonlyMap<string, PersistedAgent>,
): boolean {
  return agentId === "root" || agents.has(agentId);
}

/** Replay active-branch Registry V1/V2 entries and report precise semantic diagnostics. */
export function replayRegistryEntries(
  entries: readonly RegistryEntryLike[],
  rootSessionId: string,
  reportInvalidRecords?: (diagnostics: RegistryReplayDiagnostic[]) => void,
): RegistrySnapshot {
  const parsedEvents: Array<{ entryIndex: number; event: RegistryEventV2 }> = [];
  const diagnostics: RegistryReplayDiagnostic[] = [];
  entries.forEach((entry, entryIndex) => {
    if (entry.type !== "custom" || entry.customType !== REGISTRY_ENTRY_TYPE) return;
    const parsed = parseRegistryEventRecord(entry.data, rootSessionId);
    if (parsed.foreignRoot) return;
    if (parsed.event) parsedEvents.push({ entryIndex, event: parsed.event });
    else
      reportDiagnostic(
        diagnostics,
        entryIndex,
        parsed.code ?? "invalid-event-fields",
        parsed.message ?? "invalid Registry record",
      );
  });

  let checkpointIndex = -1;
  for (let index = parsedEvents.length - 1; index >= 0; index--) {
    if (parsedEvents[index]?.event.event === "checkpoint") {
      checkpointIndex = index;
      break;
    }
  }
  const checkpointEvent = checkpointIndex >= 0 ? parsedEvents[checkpointIndex]?.event : undefined;
  const checkpoint = checkpointEvent?.event === "checkpoint" ? checkpointEvent.snapshot : undefined;
  const agents = new Map(
    (checkpoint?.agents ?? []).map((agent) => [agent.agent_id, structuredClone(agent)]),
  );
  const tombstones = new Set(checkpoint?.tombstones ?? []);
  let ledger: DeliveryLedger = createDeliveryLedger({
    deliveries: checkpoint?.deliveries,
    coordination_deliveries: checkpoint?.coordination_deliveries,
    wait_claimed_turns: checkpoint?.wait_claimed_turns,
    next_delivery_sequence: checkpoint?.next_delivery_sequence,
  });
  const sequenceState: ReplayDeliverySequenceState = {
    terminalSequences: new Map(
      ledger.terminalDeliveries.map((delivery) => [
        terminalDeliveryIdentity(delivery),
        delivery.sequence ?? 0,
      ]),
    ),
    coordinationSequences: new Map(
      ledger.coordinationDeliveries.map((delivery) => [delivery.delivery_id, delivery.sequence]),
    ),
    highWaterMark: ledger.nextSequence - 1,
  };

  for (const { entryIndex, event } of parsedEvents.slice(checkpointIndex + 1)) {
    switch (event.event) {
      case "checkpoint":
        break;
      case "agent-created":
        if (
          event.agent.active_turn_id ||
          event.agent.latest_result ||
          event.agent.recent_messages.length > 0 ||
          event.agent.deleted
        ) {
          reportDiagnostic(
            diagnostics,
            entryIndex,
            "invalid-event-fields",
            `agent-created contains post-creation state for ${event.agent.agent_id}`,
          );
        } else if (tombstones.has(event.agent.agent_id) || agents.has(event.agent.agent_id)) {
          reportDiagnostic(
            diagnostics,
            entryIndex,
            "invalid-event-reference",
            `agent-created duplicates or resurrects ${event.agent.agent_id}`,
          );
        } else if (event.agent.parent_id !== "root" && !agents.has(event.agent.parent_id)) {
          reportDiagnostic(
            diagnostics,
            entryIndex,
            "invalid-agent-hierarchy",
            `agent-created parent is missing for ${event.agent.agent_id}`,
          );
        } else {
          agents.set(event.agent.agent_id, structuredClone(event.agent));
        }
        break;
      case "turn-started": {
        const agent = agents.get(event.agent_id);
        if (!agent || agent.active_turn_id) {
          reportDiagnostic(
            diagnostics,
            entryIndex,
            "invalid-event-reference",
            `turn-started cannot target ${event.agent_id}`,
          );
          break;
        }
        agent.active_turn_id = event.turn_id;
        agent.active_turn_started_at = event.started_at;
        agent.latest_activity_at = event.started_at;
        break;
      }
      case "turn-settled": {
        const agent = agents.get(event.result.agent_id);
        if (!agent || agent.active_turn_id !== event.result.turn_id) {
          reportDiagnostic(
            diagnostics,
            entryIndex,
            "invalid-event-reference",
            `turn-settled does not match ${event.result.agent_id} active turn`,
          );
          break;
        }
        agent.active_turn_id = undefined;
        agent.active_turn_started_at = undefined;
        agent.latest_result = structuredClone(event.result);
        agent.latest_activity_at = event.settled_at ?? event.timestamp;
        if (event.session_leaf_id) agent.session_leaf_id = event.session_leaf_id;
        break;
      }
      case "delivery-pending": {
        const delivery = observeTerminalEventSequence(sequenceState, event.delivery);
        if (!delivery) {
          reportDiagnostic(
            diagnostics,
            entryIndex,
            "invalid-delivery-sequence",
            "new terminal delivery sequences must strictly increase and updates must remain stable",
          );
          break;
        }
        const source = agents.get(delivery.source_agent_id);
        const identityError = validateDeliveryIdentity(delivery, delivery.result ? 2 : 1);
        if (identityError) {
          reportDiagnostic(diagnostics, entryIndex, "invalid-delivery-identity", identityError);
        } else if (!source) {
          reportDiagnostic(
            diagnostics,
            entryIndex,
            "invalid-event-reference",
            "terminal delivery source is not live",
          );
        } else if (source.parent_id !== delivery.destination_agent_id) {
          reportDiagnostic(
            diagnostics,
            entryIndex,
            "invalid-delivery-adjacency",
            "terminal delivery destination must be the direct parent",
          );
        } else {
          ledger = upsertTerminalDelivery(ledger, delivery).ledger;
        }
        break;
      }
      case "delivery-settled": {
        const delivery = ledger.terminalDeliveries.find(
          (candidate) =>
            candidate.source_agent_id === event.source_agent_id &&
            candidate.source_turn_id === event.source_turn_id,
        );
        if (!delivery) {
          reportDiagnostic(
            diagnostics,
            entryIndex,
            "invalid-event-reference",
            "delivery-settled has no pending terminal item",
          );
        } else if (event.error !== undefined) {
          ledger = upsertTerminalDelivery(ledger, { ...delivery, error: event.error }).ledger;
        } else {
          ledger = settleTerminalDelivery(
            ledger,
            event.source_agent_id,
            event.source_turn_id,
          ).ledger;
        }
        break;
      }
      case "delivery-pruned": {
        const delivery = ledger.terminalDeliveries.find(
          (candidate) =>
            candidate.source_agent_id === event.source_agent_id &&
            candidate.source_turn_id === event.source_turn_id,
        );
        if (!delivery || delivery.path !== "wait") {
          reportDiagnostic(
            diagnostics,
            entryIndex,
            "invalid-event-reference",
            "delivery-pruned must target one pending wait-only terminal item",
          );
          break;
        }
        ledger = settleTerminalDelivery(ledger, event.source_agent_id, event.source_turn_id).ledger;
        ledger = releaseEmptyDeliveryLedgerTurn(
          ledger,
          event.source_agent_id,
          event.source_turn_id,
          agents.get(event.source_agent_id)?.active_turn_id === event.source_turn_id,
        ).ledger;
        break;
      }
      case "coordination-delivery-pending": {
        const delivery = observeCoordinationEventSequence(sequenceState, event.delivery);
        if (!delivery) {
          reportDiagnostic(
            diagnostics,
            entryIndex,
            "invalid-delivery-sequence",
            "new Coordination Message sequences must strictly increase and updates must remain stable",
          );
          break;
        }
        const identityError = validateCoordinationIdentity(delivery);
        if (identityError) {
          reportDiagnostic(diagnostics, entryIndex, "invalid-delivery-identity", identityError);
        } else if (
          !areAdjacentAgents(
            delivery.message.details.source_agent_id,
            delivery.destination_agent_id,
            agents,
          )
        ) {
          reportDiagnostic(
            diagnostics,
            entryIndex,
            "invalid-delivery-adjacency",
            "Coordination Message endpoints must be adjacent live agents",
          );
        } else {
          ledger = upsertCoordinationDelivery(ledger, delivery).ledger;
        }
        break;
      }
      case "coordination-delivery-settled": {
        const delivery = ledger.coordinationDeliveries.find(
          (candidate) => candidate.delivery_id === event.delivery_id,
        );
        if (!delivery) {
          reportDiagnostic(
            diagnostics,
            entryIndex,
            "invalid-event-reference",
            "coordination-delivery-settled has no pending item",
          );
        } else if (event.error !== undefined) {
          ledger = upsertCoordinationDelivery(ledger, { ...delivery, error: event.error }).ledger;
        } else {
          ledger = settleCoordinationDelivery(ledger, event.delivery_id).ledger;
        }
        break;
      }
      case "delivery-turn-claimed": {
        const source = agents.get(event.source_agent_id);
        if (
          !source ||
          !isObservableSourceTurn(
            source,
            event.source_turn_id,
            ledger.terminalDeliveries,
            ledger.coordinationDeliveries,
          ) ||
          isDeliveryLedgerTurnClaimed(ledger, event.source_agent_id, event.source_turn_id)
        ) {
          reportDiagnostic(
            diagnostics,
            entryIndex,
            "invalid-event-reference",
            "delivery-turn-claimed must reference one observable unclaimed live turn",
          );
        } else {
          ledger = claimDeliveryLedgerTurn(
            ledger,
            event.source_agent_id,
            event.source_turn_id,
          ).ledger;
        }
        break;
      }
      case "delivery-turn-released":
        if (!isDeliveryLedgerTurnClaimed(ledger, event.source_agent_id, event.source_turn_id)) {
          reportDiagnostic(
            diagnostics,
            entryIndex,
            "invalid-event-reference",
            "delivery-turn-released must reference one existing wait claim",
          );
        } else {
          ledger = releaseDeliveryLedgerTurn(
            ledger,
            event.source_agent_id,
            event.source_turn_id,
          ).ledger;
        }
        break;
      case "agent-message-recorded": {
        const agent = agents.get(event.agent_id);
        if (!agent) {
          reportDiagnostic(
            diagnostics,
            entryIndex,
            "invalid-event-reference",
            `agent-message-recorded target is not live: ${event.agent_id}`,
          );
        } else if (
          !validateEventAgentReference(event.message.source_agent_id, agents) ||
          !areAdjacentAgents(event.message.source_agent_id, event.agent_id, agents)
        ) {
          reportDiagnostic(
            diagnostics,
            entryIndex,
            "invalid-delivery-adjacency",
            "recorded message endpoints must be adjacent live agents",
          );
        } else {
          agent.recent_messages.push(structuredClone(event.message));
          agent.recent_messages = agent.recent_messages.slice(-20);
          agent.latest_activity_at = event.recorded_at;
        }
        break;
      }
      case "agent-deleted": {
        const deleting = new Set(event.agent_ids);
        if (event.agent_ids.some((agentId) => !agents.has(agentId))) {
          reportDiagnostic(
            diagnostics,
            entryIndex,
            "invalid-event-reference",
            "agent-deleted must target only currently live agents",
          );
          break;
        }
        const leavesOrphan = [...agents.values()].some(
          (agent) => deleting.has(agent.parent_id) && !deleting.has(agent.agent_id),
        );
        if (leavesOrphan) {
          reportDiagnostic(
            diagnostics,
            entryIndex,
            "invalid-agent-hierarchy",
            "agent-deleted must contain every live descendant in each deleted subtree",
          );
          break;
        }
        const belongsToDeletedSubtree = (agentId: string) =>
          event.agent_ids.some(
            (deletedId) => agentId === deletedId || agentId.startsWith(`${deletedId}.`),
          );
        for (const agentId of event.agent_ids) {
          agents.delete(agentId);
          tombstones.add(agentId);
        }
        for (const agent of agents.values()) {
          agent.recent_messages = agent.recent_messages.filter(
            (message) => !belongsToDeletedSubtree(message.source_agent_id),
          );
        }
        ledger = pruneDeliveryLedgerAgents(ledger, event.agent_ids).ledger;
        break;
      }
    }
  }

  if (diagnostics.length > 0) reportInvalidRecords?.(diagnostics);
  const ledgerSnapshot = deliveryLedgerSnapshot(ledger);
  const result: RegistrySnapshot = {
    agents: [...agents.values()],
    tombstones: [...tombstones],
    deliveries: ledgerSnapshot.deliveries,
  };
  if (ledgerSnapshot.coordination_deliveries.length > 0)
    result.coordination_deliveries = ledgerSnapshot.coordination_deliveries;
  if (ledgerSnapshot.wait_claimed_turns.length > 0)
    result.wait_claimed_turns = ledgerSnapshot.wait_claimed_turns;
  const nextDeliverySequence = Math.max(
    ledgerSnapshot.next_delivery_sequence,
    sequenceState.highWaterMark + 1,
  );
  if (nextDeliverySequence > 1) result.next_delivery_sequence = nextDeliverySequence;
  return result;
}
