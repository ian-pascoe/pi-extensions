import type {
  PersistedAgent,
  PersistedDelivery,
  RegistrySnapshot,
  TurnResult,
} from "./minimal-subagents-types.js";

/** Names append-only root conversation entries that own the persistent agent registry. */
export const REGISTRY_ENTRY_TYPE = "minimal-subagents.registry";
/** Names the first custom entry that promotes a child JSONL session to persistent identity. */
export const CHILD_IDENTITY_ENTRY_TYPE = "minimal-subagents.identity";

interface RegistryEventBaseV1 {
  version: 1;
  root_session_id: string;
  timestamp: string;
}

/** Stores one complete versioned root registry checkpoint. */
export interface RegistryCheckpointV1 extends RegistryEventBaseV1 {
  event: "checkpoint";
  snapshot: RegistrySnapshot;
}

/** Records one persistent child identity before runtime initialization. */
export interface AgentCreatedV1 extends RegistryEventBaseV1 {
  event: "agent-created";
  agent: PersistedAgent;
}

/** Records one collision-resistant active turn identity and start time. */
export interface TurnStartedV1 extends RegistryEventBaseV1 {
  event: "turn-started";
  agent_id: string;
  turn_id: string;
  started_at: string;
}

/** Records one terminal turn result for waits, status, and delivery recovery. */
export interface TurnSettledV1 extends RegistryEventBaseV1 {
  event: "turn-settled";
  result: TurnResult;
}

/** Records successful output awaiting keyed destination evidence. */
export interface DeliveryPendingV1 extends RegistryEventBaseV1 {
  event: "delivery-pending";
  delivery: PersistedDelivery;
}

/** Records keyed destination evidence or the latest delivery error. */
export interface DeliverySettledV1 extends RegistryEventBaseV1 {
  event: "delivery-settled";
  source_agent_id: string;
  source_turn_id: string;
  error?: string;
}

/** Records durable deletion tombstones for canonical agent identities. */
export interface AgentDeletedV1 extends RegistryEventBaseV1 {
  event: "agent-deleted";
  agent_ids: string[];
}

/** Unites all version-one append-only registry event envelopes. */
export type RegistryEventV1 =
  | RegistryCheckpointV1
  | AgentCreatedV1
  | TurnStartedV1
  | TurnSettledV1
  | DeliveryPendingV1
  | DeliverySettledV1
  | AgentDeletedV1;

/** Defines unversioned registry payloads accepted by the event factory. */
export type RegistryEventData =
  | { event: "checkpoint"; snapshot: RegistrySnapshot }
  | { event: "agent-created"; agent: PersistedAgent }
  | { event: "turn-started"; agent_id: string; turn_id: string; started_at: string }
  | { event: "turn-settled"; result: TurnResult }
  | { event: "delivery-pending"; delivery: PersistedDelivery }
  | { event: "delivery-settled"; source_agent_id: string; source_turn_id: string; error?: string }
  | { event: "agent-deleted"; agent_ids: string[] };

/** Add the versioned root ownership envelope to one append-only registry event. */
export function createRegistryEvent<TEvent extends RegistryEventData["event"]>(
  rootSessionId: string,
  event: TEvent,
  data: Omit<Extract<RegistryEventData, { event: TEvent }>, "event">,
  timestamp = new Date().toISOString(),
): RegistryEventV1 {
  return {
    version: 1,
    root_session_id: rootSessionId,
    timestamp,
    event,
    ...data,
  } as unknown as RegistryEventV1;
}

interface RegistryEntryLike {
  type?: string;
  customType?: string;
  data?: unknown;
}

function isRegistryEvent(value: unknown, rootSessionId: string): value is RegistryEventV1 {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<RegistryEventV1>;
  return (
    candidate.version === 1 &&
    candidate.root_session_id === rootSessionId &&
    typeof candidate.timestamp === "string" &&
    typeof candidate.event === "string"
  );
}

function cloneSnapshot(snapshot: RegistrySnapshot): RegistrySnapshot {
  return structuredClone(snapshot);
}

function deliveryKey(sourceAgentId: string, sourceTurnId: string): string {
  return `${sourceAgentId}\u0000${sourceTurnId}`;
}

/** Replay root-session-wide registry entries, starting from the latest complete checkpoint. */
export function replayRegistryEntries(
  entries: readonly RegistryEntryLike[],
  rootSessionId: string,
): RegistrySnapshot {
  const events = entries
    .filter((entry) => entry.type === "custom" && entry.customType === REGISTRY_ENTRY_TYPE)
    .map((entry) => entry.data)
    .filter((data): data is RegistryEventV1 => isRegistryEvent(data, rootSessionId));
  let checkpointIndex = -1;
  for (let index = events.length - 1; index >= 0; index--) {
    if (events[index]?.event === "checkpoint") {
      checkpointIndex = index;
      break;
    }
  }

  let snapshot: RegistrySnapshot = { agents: [], tombstones: [], deliveries: [] };
  if (checkpointIndex >= 0) {
    snapshot = cloneSnapshot((events[checkpointIndex] as RegistryCheckpointV1).snapshot);
  }
  const agents = new Map(snapshot.agents.map((agent) => [agent.agent_id, agent]));
  const tombstones = new Set(snapshot.tombstones);
  const deliveries = new Map(
    snapshot.deliveries.map((delivery) => [
      deliveryKey(delivery.source_agent_id, delivery.source_turn_id),
      delivery,
    ]),
  );

  for (const event of events.slice(checkpointIndex + 1)) {
    switch (event.event) {
      case "checkpoint": {
        snapshot = cloneSnapshot(event.snapshot);
        agents.clear();
        for (const agent of snapshot.agents) agents.set(agent.agent_id, agent);
        tombstones.clear();
        for (const agentId of snapshot.tombstones) tombstones.add(agentId);
        deliveries.clear();
        for (const delivery of snapshot.deliveries) {
          deliveries.set(deliveryKey(delivery.source_agent_id, delivery.source_turn_id), delivery);
        }
        break;
      }
      case "agent-created":
        if (!tombstones.has(event.agent.agent_id))
          agents.set(event.agent.agent_id, structuredClone(event.agent));
        break;
      case "turn-started": {
        const agent = agents.get(event.agent_id);
        if (agent) {
          agent.active_turn_id = event.turn_id;
          agent.active_turn_started_at = event.started_at;
        }
        break;
      }
      case "turn-settled": {
        const agent = agents.get(event.result.agent_id);
        if (agent) {
          agent.active_turn_id = undefined;
          agent.active_turn_started_at = undefined;
          agent.latest_result = structuredClone(event.result);
        }
        break;
      }
      case "delivery-pending":
        deliveries.set(
          deliveryKey(event.delivery.source_agent_id, event.delivery.source_turn_id),
          structuredClone(event.delivery),
        );
        break;
      case "delivery-settled": {
        const delivery = deliveries.get(deliveryKey(event.source_agent_id, event.source_turn_id));
        if (delivery) {
          delivery.settled = event.error === undefined;
          delivery.error = event.error;
        }
        break;
      }
      case "agent-deleted":
        for (const agentId of event.agent_ids) {
          agents.delete(agentId);
          tombstones.add(agentId);
        }
        break;
    }
  }

  return {
    agents: [...agents.values()],
    tombstones: [...tombstones],
    deliveries: [...deliveries.values()],
  };
}
