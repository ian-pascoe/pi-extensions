import type { JsonValue } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import { COORDINATOR_TOOL_NAMES } from "./minimal-subagents-capabilities.js";
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
import {
  RegistryAgentCreatedEventWireSchema,
  RegistryAgentDeletedEventWireSchema,
  RegistryCheckpointEventWireSchema,
  RegistryCoordinationPendingEventWireSchema,
  RegistryCoordinationSettledEventWireSchema,
  RegistryDeliveryPendingEventWireSchema,
  RegistryDeliveryPrunedEventWireSchema,
  RegistryDeliverySettledEventWireSchema,
  RegistryDeliveryTurnEventWireSchema,
  RegistryEnvelopeWireSchema,
  RegistryEventDiscriminantWireSchema,
  RegistryJsonValueWireSchema,
  RegistryLooseEnvelopeWireSchema,
  RegistryMessageRecordedEventWireSchema,
  RegistryRootProbeWireSchema,
  RegistryTurnSettledEventWireSchema,
  RegistryTurnStartedEventWireSchema,
  type RegistryAgentWire,
  type RegistryCoordinationDeliveryWire,
  type RegistryCoordinatorMessageWire,
  type RegistryLaunchContractWire,
  type RegistryRecentMessageWire,
  type RegistrySnapshotWire,
  type RegistryTerminalDeliveryWire,
  type RegistryTurnResultWire,
} from "./minimal-subagents-registry-wire.js";
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

type RegistryEventFactoryArguments = {
  [TEvent in RegistryEventData["event"]]: [
    event: TEvent,
    data: Omit<Extract<RegistryEventData, { event: TEvent }>, "event">,
    timestamp?: string,
  ];
}[RegistryEventData["event"]];

/** Add an explicit Registry V2 root-ownership envelope to one append-only event. */
export function createRegistryEvent<TArguments extends RegistryEventFactoryArguments>(
  rootSessionId: string,
  ...args: TArguments
): RegistryEventBaseV2 & Extract<RegistryEventData, { event: TArguments[0] }>;
export function createRegistryEvent(
  rootSessionId: string,
  ...[event, data, suppliedTimestamp]: RegistryEventFactoryArguments
): RegistryEventV2 {
  const timestamp = suppliedTimestamp ?? new Date().toISOString();
  const envelope = { version: 2 as const, root_session_id: rootSessionId, timestamp };
  switch (event) {
    case "checkpoint": {
      const ledger = deliveryLedgerSnapshot(
        createDeliveryLedger({
          deliveries: data.snapshot.deliveries,
          coordination_deliveries: data.snapshot.coordination_deliveries,
          wait_claimed_turns: data.snapshot.wait_claimed_turns,
          next_delivery_sequence: data.snapshot.next_delivery_sequence,
        }),
      );
      return {
        ...envelope,
        event,
        snapshot: { ...structuredClone(data.snapshot), ...ledger },
      };
    }
    case "agent-created":
      return { ...envelope, event, agent: data.agent };
    case "turn-started":
      return {
        ...envelope,
        event,
        agent_id: data.agent_id,
        turn_id: data.turn_id,
        started_at: data.started_at,
      };
    case "turn-settled": {
      const result: RegistryEventV2 & { event: "turn-settled" } = {
        ...envelope,
        event,
        result: data.result,
      };
      if (data.settled_at !== undefined) result.settled_at = data.settled_at;
      if (data.session_leaf_id !== undefined) result.session_leaf_id = data.session_leaf_id;
      return result;
    }
    case "delivery-pending":
      return { ...envelope, event, delivery: data.delivery };
    case "delivery-settled": {
      const result: RegistryEventV2 & { event: "delivery-settled" } = {
        ...envelope,
        event,
        source_agent_id: data.source_agent_id,
        source_turn_id: data.source_turn_id,
      };
      if (data.error !== undefined) result.error = data.error;
      return result;
    }
    case "delivery-pruned":
      return {
        ...envelope,
        event,
        source_agent_id: data.source_agent_id,
        source_turn_id: data.source_turn_id,
        reason: data.reason,
      };
    case "coordination-delivery-pending":
      return { ...envelope, event, delivery: data.delivery };
    case "coordination-delivery-settled": {
      const result: RegistryEventV2 & { event: "coordination-delivery-settled" } = {
        ...envelope,
        event,
        delivery_id: data.delivery_id,
      };
      if (data.error !== undefined) result.error = data.error;
      return result;
    }
    case "delivery-turn-claimed":
      return {
        ...envelope,
        event,
        source_agent_id: data.source_agent_id,
        source_turn_id: data.source_turn_id,
      };
    case "delivery-turn-released":
      return {
        ...envelope,
        event,
        source_agent_id: data.source_agent_id,
        source_turn_id: data.source_turn_id,
      };
    case "agent-message-recorded":
      return {
        ...envelope,
        event,
        agent_id: data.agent_id,
        message: data.message,
        recorded_at: data.recorded_at,
      };
    case "agent-deleted":
      return { ...envelope, event, agent_ids: data.agent_ids };
  }
}

interface RegistryEntryLike {
  type?: string;
  customType?: string;
  data?: unknown;
}

type ParsedRegistryEvent =
  | { kind: "event"; event: RegistryEventV2 }
  | { kind: "foreign-root" }
  | { kind: "invalid"; code: RegistryReplayDiagnosticCode; message: string };

const FRIENDLY_AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const CANONICAL_AGENT_ID_PATTERN =
  /^(?:root\.)?[A-Za-z0-9][A-Za-z0-9_-]{0,63}(?:\.[A-Za-z0-9][A-Za-z0-9_-]{0,63})*$/;
const COORDINATOR_TOOL_NAME_SET = new Set<string>(COORDINATOR_TOOL_NAMES);

function isCanonicalModelId(value: string): boolean {
  const separatorIndex = value.indexOf("/");
  return separatorIndex > 0 && separatorIndex < value.length - 1;
}

function isOwnedTurnId(sourceAgentId: string, turnId: string): boolean {
  return turnId.startsWith(`${sourceAgentId}:`) && !turnId.includes("\u0000");
}

function isIsoTimestamp(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isUniqueNonEmptyStringArray(value: readonly string[]): boolean {
  return value.every((item) => item.length > 0) && new Set(value).size === value.length;
}

function isSafeSequence(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value < Number.MAX_SAFE_INTEGER;
}

function cloneRegistryTurnResult(value: RegistryTurnResultWire): TurnResult {
  const result: TurnResult = {
    agent_id: value.agent_id,
    turn_id: value.turn_id,
    status: value.status,
    output: value.output,
  };
  if (value.error !== undefined) result.error = value.error;
  if (value.usage !== undefined) result.usage = structuredClone(value.usage);
  if (value.elapsed_ms !== undefined) result.elapsed_ms = value.elapsed_ms;
  return result;
}

function cloneRegistryRecentMessage(value: RegistryRecentMessageWire): RecentAgentMessage {
  return {
    source_agent_id: value.source_agent_id,
    turn_id: value.turn_id,
    content: value.content,
  };
}

function excludesCoordinatorToolNames(toolNames: readonly string[]): boolean {
  return toolNames.every((toolName) => !COORDINATOR_TOOL_NAME_SET.has(toolName));
}

function parseRegistryLaunchContract(
  value: RegistryLaunchContractWire,
): LaunchContract | undefined {
  if (
    !isCanonicalModelId(value.model) ||
    !isUniqueNonEmptyStringArray(value.ordinary_tools) ||
    !excludesCoordinatorToolNames(value.ordinary_tools) ||
    (Array.isArray(value.tools) &&
      (!isUniqueNonEmptyStringArray(value.tools) || !excludesCoordinatorToolNames(value.tools)))
  ) {
    return undefined;
  }
  const launchContract: LaunchContract = {
    session_context: value.session_context,
    project_context: value.project_context,
    model: value.model,
    thinking_level: value.thinking_level,
    tools: value.tools === undefined ? undefined : structuredClone(value.tools),
    ordinary_tools: [...value.ordinary_tools],
  };
  if (value.delegation !== undefined) launchContract.delegation = value.delegation;
  return launchContract;
}

function parseRegistryAgent(value: RegistryAgentWire, version: 1 | 2): PersistedAgent | undefined {
  const launchContract = parseRegistryLaunchContract(value.launch_contract);
  if (
    value.agent_id === "root" ||
    !CANONICAL_AGENT_ID_PATTERN.test(value.agent_id) ||
    value.friendly_id === "root" ||
    value.friendly_id === "parent" ||
    !FRIENDLY_AGENT_ID_PATTERN.test(value.friendly_id) ||
    !isIsoTimestamp(value.created_at) ||
    launchContract === undefined ||
    !isUniqueNonEmptyStringArray(value.capability_ceiling) ||
    !isUniqueNonEmptyStringArray(value.missing_dependencies) ||
    (value.latest_activity_at !== undefined && !isIsoTimestamp(value.latest_activity_at)) ||
    (value.active_turn_started_at !== undefined && !isIsoTimestamp(value.active_turn_started_at))
  ) {
    return undefined;
  }
  if ((value.active_turn_id === undefined) !== (value.active_turn_started_at === undefined)) {
    return undefined;
  }
  if ((value.session_file === undefined) !== (value.session_id === undefined)) return undefined;
  if (version === 2) {
    if (value.session_leaf_id !== undefined && value.session_id === undefined) return undefined;
    if (value.session_id !== undefined && value.session_leaf_id === undefined) return undefined;
  }
  if (value.clone_error !== undefined && value.availability !== "unavailable") return undefined;
  if (!excludesCoordinatorToolNames(value.capability_ceiling)) return undefined;
  const capabilityCeiling = new Set(value.capability_ceiling);
  if (
    launchContract.ordinary_tools.length !== capabilityCeiling.size ||
    launchContract.ordinary_tools.some((toolName) => !capabilityCeiling.has(toolName))
  ) {
    return undefined;
  }
  if (value.active_turn_id !== undefined && !isOwnedTurnId(value.agent_id, value.active_turn_id)) {
    return undefined;
  }
  const expectedAgentId =
    value.parent_id === "root"
      ? [value.friendly_id, `root.${value.friendly_id}`]
      : [`${value.parent_id}.${value.friendly_id}`];
  if (!expectedAgentId.includes(value.agent_id)) return undefined;
  if (
    value.latest_result !== undefined &&
    (value.latest_result.agent_id !== value.agent_id ||
      !isOwnedTurnId(value.agent_id, value.latest_result.turn_id) ||
      value.latest_result.turn_id === value.active_turn_id)
  ) {
    return undefined;
  }

  const agent: PersistedAgent = {
    agent_id: value.agent_id,
    friendly_id: value.friendly_id,
    parent_id: value.parent_id,
    created_at: value.created_at,
    spawn_entry_id: value.spawn_entry_id,
    launch_contract: launchContract,
    capability_ceiling: [...value.capability_ceiling],
    availability: value.availability,
    missing_dependencies: [...value.missing_dependencies],
    recent_messages: value.recent_messages.map(cloneRegistryRecentMessage),
  };
  if (value.task !== undefined) agent.task = value.task;
  if (value.latest_activity_at !== undefined) agent.latest_activity_at = value.latest_activity_at;
  if (value.session_file !== undefined) agent.session_file = value.session_file;
  if (value.session_id !== undefined) agent.session_id = value.session_id;
  if (value.session_leaf_id !== undefined) agent.session_leaf_id = value.session_leaf_id;
  if (value.clone_error !== undefined) agent.clone_error = value.clone_error;
  if (value.active_turn_id !== undefined) agent.active_turn_id = value.active_turn_id;
  if (value.active_turn_started_at !== undefined) {
    agent.active_turn_started_at = value.active_turn_started_at;
  }
  if (value.latest_result !== undefined) {
    agent.latest_result = cloneRegistryTurnResult(value.latest_result);
  }
  if (value.unavailable_reason !== undefined) agent.unavailable_reason = value.unavailable_reason;
  if (value.deleted !== undefined) agent.deleted = value.deleted;
  return agent;
}

function parseRegistryTerminalDelivery(
  value: RegistryTerminalDeliveryWire,
  version: 1 | 2,
): PersistedDelivery | undefined {
  if (
    (version === 2 &&
      (value.sequence === undefined || value.result === undefined || value.settled !== false)) ||
    (value.sequence !== undefined && !isSafeSequence(value.sequence))
  ) {
    return undefined;
  }
  const delivery: PersistedDelivery = {
    source_agent_id: value.source_agent_id,
    source_turn_id: value.source_turn_id,
    destination_agent_id: value.destination_agent_id,
    path: value.path,
    settled: value.settled,
  };
  if (value.sequence !== undefined) delivery.sequence = value.sequence;
  if (value.result !== undefined) delivery.result = cloneRegistryTurnResult(value.result);
  if (value.error !== undefined) delivery.error = value.error;
  return delivery;
}

function parseRegistryCoordinatorMessage(
  value: RegistryCoordinatorMessageWire,
): CoordinatorMessage | undefined {
  if (
    value.customType !== "minimal-subagents.message" ||
    value.details.destination_agent_id === undefined ||
    value.details.delivery_id === undefined ||
    value.details.status !== undefined ||
    value.details.elapsed_ms !== undefined ||
    value.details.usage !== undefined
  ) {
    return undefined;
  }
  return {
    customType: "minimal-subagents.message",
    content: value.content,
    details: {
      source_agent_id: value.details.source_agent_id,
      destination_agent_id: value.details.destination_agent_id,
      source_turn_id: value.details.source_turn_id,
      message_id: value.details.message_id,
      delivery_id: value.details.delivery_id,
    },
  };
}

function parseRegistryCoordinationDelivery(
  value: RegistryCoordinationDeliveryWire,
  version: 1 | 2,
): PersistedCoordinationDelivery | undefined {
  const message = parseRegistryCoordinatorMessage(value.message);
  if (
    !isSafeSequence(value.sequence) ||
    message === undefined ||
    (version === 2 && value.settled)
  ) {
    return undefined;
  }
  const delivery: PersistedCoordinationDelivery = {
    delivery_id: value.delivery_id,
    sequence: value.sequence,
    destination_agent_id: value.destination_agent_id,
    path: value.path,
    settled: value.settled,
    message,
  };
  if (value.error !== undefined) delivery.error = value.error;
  return delivery;
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

type RegistrySnapshotValidationResult =
  | { kind: "valid"; snapshot: RegistrySnapshot }
  | {
      kind: "invalid";
      code: RegistryReplayDiagnosticCode;
      message: string;
    };

function invalidRegistrySnapshot(
  code: RegistryReplayDiagnosticCode,
  message: string,
): RegistrySnapshotValidationResult {
  return { kind: "invalid", code, message };
}

function validateRegistrySnapshot(
  value: RegistrySnapshotWire,
  version: 1 | 2,
): RegistrySnapshotValidationResult {
  const agents: PersistedAgent[] = [];
  for (const wireAgent of value.agents) {
    const agent = parseRegistryAgent(wireAgent, version);
    if (agent === undefined) {
      return invalidRegistrySnapshot(
        "invalid-checkpoint",
        "snapshot agents are incomplete or invalid",
      );
    }
    agents.push(agent);
  }
  if (!hasValidAgentHierarchy(agents)) {
    return invalidRegistrySnapshot(
      "invalid-agent-hierarchy",
      "snapshot agent hierarchy is invalid",
    );
  }
  if (!isUniqueNonEmptyStringArray(value.tombstones)) {
    return invalidRegistrySnapshot(
      "invalid-checkpoint",
      "snapshot tombstones must be unique agent IDs",
    );
  }
  const tombstones = [...value.tombstones];
  if (
    tombstones.some((agentId) => agentId === "root" || !CANONICAL_AGENT_ID_PATTERN.test(agentId))
  ) {
    return invalidRegistrySnapshot(
      "invalid-agent-hierarchy",
      "tombstone agent ID is not canonical",
    );
  }
  if (agents.some((agent) => agent.deleted === true)) {
    return invalidRegistrySnapshot(
      "invalid-agent-hierarchy",
      "live snapshot agents cannot be deleted",
    );
  }
  const agentIds = new Set(agents.map((agent) => agent.agent_id));
  if (tombstones.some((agentId) => agentIds.has(agentId))) {
    return invalidRegistrySnapshot(
      "invalid-agent-hierarchy",
      "live agents cannot also be tombstoned",
    );
  }

  const deliveries: PersistedDelivery[] = [];
  for (const wireDelivery of value.deliveries) {
    const delivery = parseRegistryTerminalDelivery(wireDelivery, version);
    if (delivery === undefined) {
      return invalidRegistrySnapshot(
        "invalid-checkpoint",
        "snapshot terminal deliveries are invalid",
      );
    }
    deliveries.push(delivery);
  }
  if (version === 2 && value.coordination_deliveries === undefined) {
    return invalidRegistrySnapshot(
      "invalid-checkpoint",
      "Registry V2 checkpoint must include coordination_deliveries",
    );
  }
  const coordinationDeliveries: PersistedCoordinationDelivery[] = [];
  for (const wireDelivery of value.coordination_deliveries ?? []) {
    const delivery = parseRegistryCoordinationDelivery(wireDelivery, version);
    if (delivery === undefined) {
      return invalidRegistrySnapshot(
        "invalid-checkpoint",
        "snapshot Coordination Messages are invalid",
      );
    }
    coordinationDeliveries.push(delivery);
  }
  if (version === 2 && value.wait_claimed_turns === undefined) {
    return invalidRegistrySnapshot(
      "invalid-checkpoint",
      "Registry V2 checkpoint must include wait_claimed_turns",
    );
  }
  const waitClaimedTurns = value.wait_claimed_turns ?? [];
  if (
    !isUniqueNonEmptyStringArray(waitClaimedTurns) ||
    waitClaimedTurns.some(
      (key) => key.indexOf("\u0000") <= 0 || key.indexOf("\u0000") !== key.lastIndexOf("\u0000"),
    )
  ) {
    return invalidRegistrySnapshot("invalid-checkpoint", "snapshot wait claims are invalid");
  }
  if (version === 2 && value.next_delivery_sequence === undefined) {
    return invalidRegistrySnapshot(
      "invalid-delivery-sequence",
      "Registry V2 checkpoint must include next_delivery_sequence",
    );
  }
  if (value.next_delivery_sequence !== undefined && !isSafeSequence(value.next_delivery_sequence)) {
    return invalidRegistrySnapshot(
      "invalid-delivery-sequence",
      "next_delivery_sequence must be a positive safe integer",
    );
  }

  const agentsById = new Map(agents.map((agent) => [agent.agent_id, agent]));
  for (const agent of agents) {
    if (version === 2 && agent.recent_messages.length > 20) {
      return invalidRegistrySnapshot(
        "invalid-checkpoint",
        "agent recent_messages exceeds the 20-item projection limit",
      );
    }
    for (const message of agent.recent_messages) {
      if (
        !isOwnedTurnId(message.source_agent_id, message.turn_id) ||
        !areAdjacentAgents(message.source_agent_id, agent.agent_id, agentsById)
      ) {
        return invalidRegistrySnapshot(
          "invalid-delivery-adjacency",
          "recent message endpoints and source turn must identify adjacent agents",
        );
      }
    }
  }
  const terminalDeliveryKeys = deliveries.map(
    (delivery) => `${delivery.source_agent_id}\u0000${delivery.source_turn_id}`,
  );
  if (new Set(terminalDeliveryKeys).size !== terminalDeliveryKeys.length) {
    return invalidRegistrySnapshot(
      "invalid-delivery-identity",
      "terminal delivery source-turn identities must be unique",
    );
  }
  const coordinationDeliveryIds = coordinationDeliveries.map((delivery) => delivery.delivery_id);
  if (new Set(coordinationDeliveryIds).size !== coordinationDeliveryIds.length) {
    return invalidRegistrySnapshot(
      "invalid-delivery-identity",
      "Coordination Message delivery IDs must be unique",
    );
  }
  const waitTerminalCounts = new Map<string, number>();
  for (const delivery of deliveries) {
    if (delivery.path === "wait") {
      const count = (waitTerminalCounts.get(delivery.source_agent_id) ?? 0) + 1;
      waitTerminalCounts.set(delivery.source_agent_id, count);
      if (version === 2 && count > WAIT_TERMINAL_RETENTION_LIMIT) {
        return invalidRegistrySnapshot(
          "invalid-checkpoint",
          `wait-only terminal retention exceeds ${WAIT_TERMINAL_RETENTION_LIMIT} items for one source agent`,
        );
      }
    }
    const identityError = validateDeliveryIdentity(delivery, version);
    if (identityError) return invalidRegistrySnapshot("invalid-delivery-identity", identityError);
    const source = agentsById.get(delivery.source_agent_id);
    if (!source) {
      return invalidRegistrySnapshot(
        "invalid-event-reference",
        "terminal delivery source is not live",
      );
    }
    if (source.parent_id !== delivery.destination_agent_id) {
      return invalidRegistrySnapshot(
        "invalid-delivery-adjacency",
        "terminal delivery destination must be the source agent direct parent",
      );
    }
  }
  for (const delivery of coordinationDeliveries) {
    const identityError = validateCoordinationIdentity(delivery);
    if (identityError) return invalidRegistrySnapshot("invalid-delivery-identity", identityError);
    if (
      !areAdjacentAgents(
        delivery.message.details.source_agent_id,
        delivery.destination_agent_id,
        agentsById,
      )
    ) {
      return invalidRegistrySnapshot(
        "invalid-delivery-adjacency",
        "Coordination Message endpoints must be adjacent live agents",
      );
    }
  }
  const sequences = [
    ...deliveries.flatMap((delivery) =>
      delivery.sequence === undefined ? [] : [delivery.sequence],
    ),
    ...coordinationDeliveries.map((delivery) => delivery.sequence),
  ];
  if (new Set(sequences).size !== sequences.length) {
    return invalidRegistrySnapshot(
      "invalid-delivery-sequence",
      "delivery sequences must be unique",
    );
  }
  if (
    value.next_delivery_sequence !== undefined &&
    sequences.some((sequence) => sequence >= Number(value.next_delivery_sequence))
  ) {
    return invalidRegistrySnapshot(
      "invalid-delivery-sequence",
      "next_delivery_sequence must be greater than every retained sequence",
    );
  }
  for (const key of waitClaimedTurns) {
    const separatorIndex = key.indexOf("\u0000");
    const sourceAgentId = key.slice(0, separatorIndex);
    const sourceTurnId = key.slice(separatorIndex + 1);
    const sourceAgent = agentsById.get(sourceAgentId);
    if (
      !sourceAgent ||
      !isOwnedTurnId(sourceAgentId, sourceTurnId) ||
      !isObservableSourceTurn(sourceAgent, sourceTurnId, deliveries, coordinationDeliveries)
    ) {
      return invalidRegistrySnapshot(
        "invalid-event-reference",
        "wait claim must reference an active, latest, or retained source turn",
      );
    }
  }

  if (version === 1) {
    for (const agent of agents) {
      if (!agent.session_id) agent.session_leaf_id = undefined;
      agent.recent_messages = agent.recent_messages.slice(-20);
    }
  }
  const snapshot: RegistrySnapshot = { agents, tombstones, deliveries };
  if (coordinationDeliveries.length > 0 || value.coordination_deliveries !== undefined) {
    snapshot.coordination_deliveries = coordinationDeliveries;
  }
  if (waitClaimedTurns.length > 0 || value.wait_claimed_turns !== undefined) {
    snapshot.wait_claimed_turns = [...waitClaimedTurns];
  }
  if (value.next_delivery_sequence !== undefined) {
    snapshot.next_delivery_sequence = value.next_delivery_sequence;
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
  return { kind: "valid", snapshot };
}

function invalidParsedEvent(
  code: RegistryReplayDiagnosticCode,
  message: string,
): ParsedRegistryEvent {
  return { kind: "invalid", code, message };
}

function validParsedEvent(event: RegistryEventV2): ParsedRegistryEvent {
  return { kind: "event", event };
}

type RegistryParseInput = JsonValue | RegistryEventV2;

function parseRegistryEventRecord(
  value: RegistryParseInput,
  rootSessionId: string,
): ParsedRegistryEvent {
  if (Value.Check(RegistryRootProbeWireSchema, value) && value.root_session_id !== rootSessionId) {
    return { kind: "foreign-root" };
  }
  if (!Value.Check(RegistryLooseEnvelopeWireSchema, value) || !isIsoTimestamp(value.timestamp)) {
    return invalidParsedEvent(
      "invalid-envelope",
      "root_session_id and timestamp must be valid strings",
    );
  }
  if (value.version !== 1 && value.version !== 2) {
    return invalidParsedEvent("unsupported-version", "Registry version must be 1 or 2");
  }
  if (!Value.Check(RegistryEventDiscriminantWireSchema, value)) {
    return invalidParsedEvent("invalid-event-fields", "event discriminant must be a string");
  }
  if (!Value.Check(RegistryEnvelopeWireSchema, value)) {
    return invalidParsedEvent("invalid-envelope", "Registry envelope is invalid");
  }
  const version = value.version;
  const timestamp = value.timestamp;
  switch (value.event) {
    case "checkpoint": {
      if (!Value.Check(RegistryCheckpointEventWireSchema, value)) {
        return invalidParsedEvent("invalid-checkpoint", "snapshot must be an object");
      }
      const parsed = validateRegistrySnapshot(value.snapshot, version);
      if (parsed.kind === "invalid") return invalidParsedEvent(parsed.code, parsed.message);
      return validParsedEvent(
        createRegistryEvent(rootSessionId, "checkpoint", { snapshot: parsed.snapshot }, timestamp),
      );
    }
    case "agent-created": {
      if (!Value.Check(RegistryAgentCreatedEventWireSchema, value)) {
        return invalidParsedEvent("invalid-event-fields", "agent-created agent is incomplete");
      }
      const agent = parseRegistryAgent(value.agent, version);
      if (agent === undefined || (version === 2 && agent.recent_messages.length > 20)) {
        return invalidParsedEvent("invalid-event-fields", "agent-created agent is incomplete");
      }
      if (version === 1) {
        if (!agent.session_id) agent.session_leaf_id = undefined;
        agent.recent_messages = agent.recent_messages.slice(-20);
      }
      return validParsedEvent(
        createRegistryEvent(rootSessionId, "agent-created", { agent }, timestamp),
      );
    }
    case "turn-started":
      if (
        !Value.Check(RegistryTurnStartedEventWireSchema, value) ||
        !isOwnedTurnId(value.agent_id, value.turn_id) ||
        !isIsoTimestamp(value.started_at)
      ) {
        return invalidParsedEvent("invalid-event-fields", "turn-started fields are invalid");
      }
      return validParsedEvent(
        createRegistryEvent(
          rootSessionId,
          "turn-started",
          {
            agent_id: value.agent_id,
            turn_id: value.turn_id,
            started_at: value.started_at,
          },
          timestamp,
        ),
      );
    case "turn-settled": {
      if (
        !Value.Check(RegistryTurnSettledEventWireSchema, value) ||
        !isOwnedTurnId(value.result.agent_id, value.result.turn_id) ||
        (value.settled_at !== undefined && !isIsoTimestamp(value.settled_at))
      ) {
        return invalidParsedEvent("invalid-event-fields", "turn-settled fields are invalid");
      }
      const data: Omit<Extract<RegistryEventData, { event: "turn-settled" }>, "event"> = {
        result: cloneRegistryTurnResult(value.result),
      };
      if (value.settled_at !== undefined) data.settled_at = value.settled_at;
      if (value.session_leaf_id !== undefined) data.session_leaf_id = value.session_leaf_id;
      return validParsedEvent(createRegistryEvent(rootSessionId, "turn-settled", data, timestamp));
    }
    case "delivery-pending": {
      if (!Value.Check(RegistryDeliveryPendingEventWireSchema, value)) {
        return invalidParsedEvent("invalid-event-fields", "terminal delivery fields are invalid");
      }
      const delivery = parseRegistryTerminalDelivery(value.delivery, version);
      if (delivery === undefined) {
        return invalidParsedEvent("invalid-event-fields", "terminal delivery fields are invalid");
      }
      const identityError = validateDeliveryIdentity(delivery, version);
      if (identityError !== undefined) {
        return invalidParsedEvent("invalid-delivery-identity", identityError);
      }
      return validParsedEvent(
        createRegistryEvent(rootSessionId, "delivery-pending", { delivery }, timestamp),
      );
    }
    case "delivery-settled": {
      if (
        !Value.Check(RegistryDeliverySettledEventWireSchema, value) ||
        !isOwnedTurnId(value.source_agent_id, value.source_turn_id)
      ) {
        return invalidParsedEvent("invalid-event-fields", "delivery-settled fields are invalid");
      }
      const data: Omit<Extract<RegistryEventData, { event: "delivery-settled" }>, "event"> = {
        source_agent_id: value.source_agent_id,
        source_turn_id: value.source_turn_id,
      };
      if (value.error !== undefined) data.error = value.error;
      return validParsedEvent(
        createRegistryEvent(rootSessionId, "delivery-settled", data, timestamp),
      );
    }
    case "delivery-pruned":
      if (
        version !== 2 ||
        !Value.Check(RegistryDeliveryPrunedEventWireSchema, value) ||
        !isOwnedTurnId(value.source_agent_id, value.source_turn_id)
      ) {
        return invalidParsedEvent("invalid-event-fields", "delivery-pruned fields are invalid");
      }
      return validParsedEvent(
        createRegistryEvent(
          rootSessionId,
          "delivery-pruned",
          {
            source_agent_id: value.source_agent_id,
            source_turn_id: value.source_turn_id,
            reason: "retention-limit",
          },
          timestamp,
        ),
      );
    case "coordination-delivery-pending": {
      if (!Value.Check(RegistryCoordinationPendingEventWireSchema, value)) {
        return invalidParsedEvent(
          "invalid-event-fields",
          "Coordination Message delivery fields are invalid",
        );
      }
      const delivery = parseRegistryCoordinationDelivery(value.delivery, version);
      if (delivery === undefined) {
        return invalidParsedEvent(
          "invalid-event-fields",
          "Coordination Message delivery fields are invalid",
        );
      }
      const identityError = validateCoordinationIdentity(delivery);
      if (identityError !== undefined) {
        return invalidParsedEvent("invalid-delivery-identity", identityError);
      }
      return validParsedEvent(
        createRegistryEvent(
          rootSessionId,
          "coordination-delivery-pending",
          { delivery },
          timestamp,
        ),
      );
    }
    case "coordination-delivery-settled": {
      if (!Value.Check(RegistryCoordinationSettledEventWireSchema, value)) {
        return invalidParsedEvent(
          "invalid-event-fields",
          "coordination-delivery-settled fields are invalid",
        );
      }
      const data: Omit<
        Extract<RegistryEventData, { event: "coordination-delivery-settled" }>,
        "event"
      > = { delivery_id: value.delivery_id };
      if (value.error !== undefined) data.error = value.error;
      return validParsedEvent(
        createRegistryEvent(rootSessionId, "coordination-delivery-settled", data, timestamp),
      );
    }
    case "delivery-turn-claimed":
    case "delivery-turn-released":
      if (
        !Value.Check(RegistryDeliveryTurnEventWireSchema, value) ||
        !isOwnedTurnId(value.source_agent_id, value.source_turn_id)
      ) {
        return invalidParsedEvent("invalid-event-fields", `${value.event} fields are invalid`);
      }
      if (value.event === "delivery-turn-claimed") {
        return validParsedEvent(
          createRegistryEvent(
            rootSessionId,
            "delivery-turn-claimed",
            {
              source_agent_id: value.source_agent_id,
              source_turn_id: value.source_turn_id,
            },
            timestamp,
          ),
        );
      }
      return validParsedEvent(
        createRegistryEvent(
          rootSessionId,
          "delivery-turn-released",
          {
            source_agent_id: value.source_agent_id,
            source_turn_id: value.source_turn_id,
          },
          timestamp,
        ),
      );
    case "agent-message-recorded":
      if (
        !Value.Check(RegistryMessageRecordedEventWireSchema, value) ||
        !isOwnedTurnId(value.message.source_agent_id, value.message.turn_id) ||
        (version === 2 && (value.recorded_at === undefined || !isIsoTimestamp(value.recorded_at)))
      ) {
        return invalidParsedEvent("invalid-event-fields", "agent activity fields are invalid");
      }
      const recordedAt = version === 1 ? timestamp : value.recorded_at;
      if (recordedAt === undefined) {
        return invalidParsedEvent("invalid-event-fields", "agent activity fields are invalid");
      }
      return validParsedEvent(
        createRegistryEvent(
          rootSessionId,
          "agent-message-recorded",
          {
            agent_id: value.agent_id,
            message: cloneRegistryRecentMessage(value.message),
            recorded_at: recordedAt,
          },
          timestamp,
        ),
      );
    case "agent-deleted":
      if (
        !Value.Check(RegistryAgentDeletedEventWireSchema, value) ||
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
      return validParsedEvent(
        createRegistryEvent(
          rootSessionId,
          "agent-deleted",
          { agent_ids: [...value.agent_ids] },
          timestamp,
        ),
      );
    default:
      return invalidParsedEvent("invalid-event-fields", `unknown Registry event: ${value.event}`);
  }
}

/** Parse one V1 or V2 Registry payload into the current V2 representation without throwing. */
export function parseRegistryEvent(
  value: RegistryParseInput,
  rootSessionId: string,
): RegistryEventV2 | undefined {
  const parsed = parseRegistryEventRecord(value, rootSessionId);
  return parsed.kind === "event" ? parsed.event : undefined;
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
    if (!Value.Check(RegistryJsonValueWireSchema, entry.data)) {
      reportDiagnostic(diagnostics, entryIndex, "invalid-envelope", "record must be JSON");
      return;
    }
    const parsed = parseRegistryEventRecord(entry.data, rootSessionId);
    if (parsed.kind === "foreign-root") return;
    if (parsed.kind === "event") {
      parsedEvents.push({ entryIndex, event: parsed.event });
    } else {
      reportDiagnostic(diagnostics, entryIndex, parsed.code, parsed.message);
    }
  });

  const checkpointIndex = parsedEvents.findLastIndex(({ event }) => event.event === "checkpoint");
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
