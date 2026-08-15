import type {
  CoordinatorMessage,
  DeliveryPath,
  PersistedCoordinationDelivery,
  PersistedDelivery,
  TurnResult,
} from "./minimal-subagents-types.js";

/** Maximum pending wait-only terminal results retained for one source agent. */
export const WAIT_TERMINAL_RETENTION_LIMIT = 20;

/** Immutable, process-local state for sequenced pending deliveries and durable wait claims. */
export interface DeliveryLedger {
  /** Pending successful terminal results, including at most 20 wait-only items per source. */
  readonly terminalDeliveries: readonly PersistedDelivery[];
  /** Pending Coordination Messages, which are never removed by terminal retention. */
  readonly coordinationDeliveries: readonly PersistedCoordinationDelivery[];
  /** Source-agent and source-turn compound keys durably owned by wait delivery. */
  readonly waitClaimedTurns: readonly string[];
  /** Next positive safe sequence shared by both delivery kinds. */
  readonly nextSequence: number;
}

/** Serializable fields owned by the Delivery Ledger inside a Registry checkpoint. */
export interface DeliveryLedgerSnapshot {
  deliveries: PersistedDelivery[];
  coordination_deliveries: PersistedCoordinationDelivery[];
  wait_claimed_turns: string[];
  next_delivery_sequence: number;
}

/** Returns one immutable Delivery Ledger transition and any terminal items evicted by retention. */
export interface DeliveryLedgerTransition {
  ledger: DeliveryLedger;
  prunedTerminalDeliveries: PersistedDelivery[];
}

/** Returns a newly sequenced terminal delivery with its immutable ledger transition. */
export interface AddedTerminalDelivery extends DeliveryLedgerTransition {
  delivery: PersistedDelivery;
}

/** Returns a newly sequenced Coordination Message with its immutable ledger transition. */
export interface AddedCoordinationDelivery extends DeliveryLedgerTransition {
  delivery: PersistedCoordinationDelivery;
}

/** Describes caller-visible inputs used to select the oldest observable source turn. */
export interface SelectObservableDeliveryTurnOptions {
  sourceAgentId: string;
  destinationAgentId: string;
  waitHandedDeliveryIds: ReadonlySet<string>;
  activeTurnId?: string;
  latestResultTurnId?: string;
}

function deliveryTurnKey(sourceAgentId: string, sourceTurnId: string): string {
  return `${sourceAgentId}\u0000${sourceTurnId}`;
}

function cloneTerminalDelivery(delivery: PersistedDelivery): PersistedDelivery {
  return structuredClone(delivery);
}

function cloneCoordinationDelivery(
  delivery: PersistedCoordinationDelivery,
): PersistedCoordinationDelivery {
  return structuredClone(delivery);
}

function createTransition(
  ledger: DeliveryLedger,
  prunedTerminalDeliveries: readonly PersistedDelivery[] = [],
): DeliveryLedgerTransition {
  return {
    ledger,
    prunedTerminalDeliveries: prunedTerminalDeliveries.map(cloneTerminalDelivery),
  };
}

function normalizeDeliveryLedgerRetention(ledger: DeliveryLedger): DeliveryLedgerTransition {
  const retainedKeys = new Set<string>();
  const prunedTerminalDeliveries: PersistedDelivery[] = [];
  const waitDeliveriesBySource = new Map<string, PersistedDelivery[]>();
  for (const delivery of ledger.terminalDeliveries) {
    if (delivery.path !== "wait") continue;
    const sourceDeliveries = waitDeliveriesBySource.get(delivery.source_agent_id) ?? [];
    sourceDeliveries.push(delivery);
    waitDeliveriesBySource.set(delivery.source_agent_id, sourceDeliveries);
  }
  for (const sourceDeliveries of waitDeliveriesBySource.values()) {
    sourceDeliveries.sort((left, right) => (right.sequence ?? 0) - (left.sequence ?? 0));
    for (const delivery of sourceDeliveries.slice(0, WAIT_TERMINAL_RETENTION_LIMIT)) {
      retainedKeys.add(deliveryTurnKey(delivery.source_agent_id, delivery.source_turn_id));
    }
    prunedTerminalDeliveries.push(...sourceDeliveries.slice(WAIT_TERMINAL_RETENTION_LIMIT));
  }
  if (prunedTerminalDeliveries.length === 0) return createTransition(ledger);

  const terminalDeliveries = ledger.terminalDeliveries.filter(
    (delivery) =>
      delivery.path !== "wait" ||
      retainedKeys.has(deliveryTurnKey(delivery.source_agent_id, delivery.source_turn_id)),
  );
  const coordinationTurnKeys = new Set(
    ledger.coordinationDeliveries.map((delivery) =>
      deliveryTurnKey(
        delivery.message.details.source_agent_id,
        delivery.message.details.source_turn_id,
      ),
    ),
  );
  const prunedTerminalKeys = new Set(
    prunedTerminalDeliveries.map((delivery) =>
      deliveryTurnKey(delivery.source_agent_id, delivery.source_turn_id),
    ),
  );
  const waitClaimedTurns = ledger.waitClaimedTurns.filter(
    (key) => !prunedTerminalKeys.has(key) || coordinationTurnKeys.has(key),
  );
  return createTransition(
    {
      ...ledger,
      terminalDeliveries,
      waitClaimedTurns,
    },
    prunedTerminalDeliveries,
  );
}

/** Rehydrate a Delivery Ledger, assigning deterministic sequences to legacy V1 terminal items. */
export function createDeliveryLedger(
  snapshot: Partial<DeliveryLedgerSnapshot> = {},
): DeliveryLedger {
  const coordinationDeliveries = (snapshot.coordination_deliveries ?? [])
    .filter((delivery) => !delivery.settled)
    .map(cloneCoordinationDelivery);
  let nextSequence = Math.max(
    1,
    snapshot.next_delivery_sequence ?? 1,
    ...coordinationDeliveries.map((delivery) => delivery.sequence + 1),
    ...(snapshot.deliveries ?? []).flatMap((delivery) =>
      delivery.settled || delivery.sequence === undefined ? [] : [delivery.sequence + 1],
    ),
  );
  const terminalDeliveries = (snapshot.deliveries ?? [])
    .filter((delivery) => !delivery.settled)
    .map((delivery) => {
      const restored = cloneTerminalDelivery(delivery);
      if (restored.sequence === undefined) restored.sequence = nextSequence++;
      return restored;
    });
  return normalizeDeliveryLedgerRetention({
    terminalDeliveries,
    coordinationDeliveries,
    waitClaimedTurns: [...(snapshot.wait_claimed_turns ?? [])],
    nextSequence,
  }).ledger;
}

/** Serialize pending Delivery Ledger state without exposing mutable internal references. */
export function deliveryLedgerSnapshot(ledger: DeliveryLedger): DeliveryLedgerSnapshot {
  return {
    deliveries: ledger.terminalDeliveries.map(cloneTerminalDelivery),
    coordination_deliveries: ledger.coordinationDeliveries.map(cloneCoordinationDelivery),
    wait_claimed_turns: [...ledger.waitClaimedTurns],
    next_delivery_sequence: ledger.nextSequence,
  };
}

/** Allocate and retain one pending successful terminal result. */
export function addTerminalDelivery(
  ledger: DeliveryLedger,
  input: { destinationAgentId: string; path: DeliveryPath; result: TurnResult },
): AddedTerminalDelivery {
  const delivery: PersistedDelivery = {
    source_agent_id: input.result.agent_id,
    source_turn_id: input.result.turn_id,
    destination_agent_id: input.destinationAgentId,
    path: input.path,
    settled: false,
    sequence: ledger.nextSequence,
    result: structuredClone(input.result),
  };
  const transition = normalizeDeliveryLedgerRetention({
    ...ledger,
    terminalDeliveries: [
      ...ledger.terminalDeliveries.filter(
        (current) =>
          deliveryTurnKey(current.source_agent_id, current.source_turn_id) !==
          deliveryTurnKey(delivery.source_agent_id, delivery.source_turn_id),
      ),
      delivery,
    ],
    nextSequence: ledger.nextSequence + 1,
  });
  return { ...transition, delivery: cloneTerminalDelivery(delivery) };
}

/** Replay or update one already-sequenced terminal delivery. */
export function upsertTerminalDelivery(
  ledger: DeliveryLedger,
  delivery: PersistedDelivery,
): DeliveryLedgerTransition {
  const restored = cloneTerminalDelivery(delivery);
  const existing = ledger.terminalDeliveries.find(
    (current) =>
      deliveryTurnKey(current.source_agent_id, current.source_turn_id) ===
      deliveryTurnKey(restored.source_agent_id, restored.source_turn_id),
  );
  const sequence = restored.sequence ?? existing?.sequence ?? ledger.nextSequence;
  restored.sequence = sequence;
  return normalizeDeliveryLedgerRetention({
    ...ledger,
    terminalDeliveries: [
      ...ledger.terminalDeliveries.filter(
        (current) =>
          deliveryTurnKey(current.source_agent_id, current.source_turn_id) !==
          deliveryTurnKey(restored.source_agent_id, restored.source_turn_id),
      ),
      restored,
    ],
    nextSequence: Math.max(ledger.nextSequence, sequence + 1),
  });
}

/** Allocate and retain one pending Coordination Message delivery. */
export function addCoordinationDelivery(
  ledger: DeliveryLedger,
  input: { destinationAgentId: string; message: CoordinatorMessage },
): AddedCoordinationDelivery {
  const deliveryId = `message:${input.message.details.message_id}`;
  const message = structuredClone(input.message);
  message.details.delivery_id = deliveryId;
  const delivery: PersistedCoordinationDelivery = {
    delivery_id: deliveryId,
    sequence: ledger.nextSequence,
    destination_agent_id: input.destinationAgentId,
    path: "message",
    settled: false,
    message,
  };
  return {
    ledger: {
      ...ledger,
      coordinationDeliveries: [
        ...ledger.coordinationDeliveries.filter(
          (current) => current.delivery_id !== delivery.delivery_id,
        ),
        delivery,
      ],
      nextSequence: ledger.nextSequence + 1,
    },
    delivery: cloneCoordinationDelivery(delivery),
    prunedTerminalDeliveries: [],
  };
}

/** Replay or update one already-sequenced Coordination Message delivery. */
export function upsertCoordinationDelivery(
  ledger: DeliveryLedger,
  delivery: PersistedCoordinationDelivery,
): DeliveryLedgerTransition {
  return createTransition({
    ...ledger,
    coordinationDeliveries: [
      ...ledger.coordinationDeliveries.filter(
        (current) => current.delivery_id !== delivery.delivery_id,
      ),
      cloneCoordinationDelivery(delivery),
    ],
    nextSequence: Math.max(ledger.nextSequence, delivery.sequence + 1),
  });
}

/** Change one terminal delivery path and enforce wait-only terminal retention. */
export function setTerminalDeliveryPath(
  ledger: DeliveryLedger,
  sourceAgentId: string,
  sourceTurnId: string,
  path: DeliveryPath,
): DeliveryLedgerTransition {
  const key = deliveryTurnKey(sourceAgentId, sourceTurnId);
  return normalizeDeliveryLedgerRetention({
    ...ledger,
    terminalDeliveries: ledger.terminalDeliveries.map((delivery) =>
      deliveryTurnKey(delivery.source_agent_id, delivery.source_turn_id) === key
        ? { ...delivery, path }
        : delivery,
    ),
  });
}

/** Change one Coordination Message path without changing its sequence identity. */
export function setCoordinationDeliveryPath(
  ledger: DeliveryLedger,
  deliveryId: string,
  path: DeliveryPath,
): DeliveryLedger {
  return {
    ...ledger,
    coordinationDeliveries: ledger.coordinationDeliveries.map((delivery) =>
      delivery.delivery_id === deliveryId ? { ...delivery, path } : delivery,
    ),
  };
}

/** Record or clear one terminal delivery attempt error. */
export function setTerminalDeliveryError(
  ledger: DeliveryLedger,
  sourceAgentId: string,
  sourceTurnId: string,
  error: string | undefined,
): DeliveryLedger {
  const key = deliveryTurnKey(sourceAgentId, sourceTurnId);
  return {
    ...ledger,
    terminalDeliveries: ledger.terminalDeliveries.map((delivery) => {
      if (deliveryTurnKey(delivery.source_agent_id, delivery.source_turn_id) !== key)
        return delivery;
      const next = { ...delivery };
      if (error === undefined) delete next.error;
      else next.error = error;
      return next;
    }),
  };
}

/** Record or clear one Coordination Message delivery attempt error. */
export function setCoordinationDeliveryError(
  ledger: DeliveryLedger,
  deliveryId: string,
  error: string | undefined,
): DeliveryLedger {
  return {
    ...ledger,
    coordinationDeliveries: ledger.coordinationDeliveries.map((delivery) => {
      if (delivery.delivery_id !== deliveryId) return delivery;
      const next = { ...delivery };
      if (error === undefined) delete next.error;
      else next.error = error;
      return next;
    }),
  };
}

/** Remove one keyed terminal delivery while preserving its wait claim for explicit release policy. */
export function settleTerminalDelivery(
  ledger: DeliveryLedger,
  sourceAgentId: string,
  sourceTurnId: string,
): DeliveryLedgerTransition {
  const key = deliveryTurnKey(sourceAgentId, sourceTurnId);
  return createTransition({
    ...ledger,
    terminalDeliveries: ledger.terminalDeliveries.filter(
      (delivery) => deliveryTurnKey(delivery.source_agent_id, delivery.source_turn_id) !== key,
    ),
  });
}

/** Remove one keyed Coordination Message while preserving its wait claim for explicit release policy. */
export function settleCoordinationDelivery(
  ledger: DeliveryLedger,
  deliveryId: string,
): DeliveryLedgerTransition {
  return createTransition({
    ...ledger,
    coordinationDeliveries: ledger.coordinationDeliveries.filter(
      (delivery) => delivery.delivery_id !== deliveryId,
    ),
  });
}

/** Durably claim all retained items for one source turn for wait delivery. */
export function claimDeliveryLedgerTurn(
  ledger: DeliveryLedger,
  sourceAgentId: string,
  sourceTurnId: string,
): DeliveryLedgerTransition & { changed: boolean } {
  const key = deliveryTurnKey(sourceAgentId, sourceTurnId);
  if (ledger.waitClaimedTurns.includes(key)) return { ...createTransition(ledger), changed: false };
  return {
    ...createTransition({ ...ledger, waitClaimedTurns: [...ledger.waitClaimedTurns, key] }),
    changed: true,
  };
}

/** Release one source-turn wait claim regardless of retained delivery state. */
export function releaseDeliveryLedgerTurn(
  ledger: DeliveryLedger,
  sourceAgentId: string,
  sourceTurnId: string,
): DeliveryLedgerTransition & { changed: boolean } {
  const key = deliveryTurnKey(sourceAgentId, sourceTurnId);
  if (!ledger.waitClaimedTurns.includes(key))
    return { ...createTransition(ledger), changed: false };
  return {
    ...createTransition({
      ...ledger,
      waitClaimedTurns: ledger.waitClaimedTurns.filter((current) => current !== key),
    }),
    changed: true,
  };
}

/** Release a source-turn wait claim only after the turn and all its retained items are absent. */
export function releaseEmptyDeliveryLedgerTurn(
  ledger: DeliveryLedger,
  sourceAgentId: string,
  sourceTurnId: string,
  sourceTurnActive: boolean,
): DeliveryLedgerTransition & { changed: boolean } {
  if (sourceTurnActive) return { ...createTransition(ledger), changed: false };
  const key = deliveryTurnKey(sourceAgentId, sourceTurnId);
  const hasTerminal = ledger.terminalDeliveries.some(
    (delivery) => deliveryTurnKey(delivery.source_agent_id, delivery.source_turn_id) === key,
  );
  const hasCoordination = ledger.coordinationDeliveries.some(
    (delivery) =>
      deliveryTurnKey(
        delivery.message.details.source_agent_id,
        delivery.message.details.source_turn_id,
      ) === key,
  );
  return hasTerminal || hasCoordination
    ? { ...createTransition(ledger), changed: false }
    : releaseDeliveryLedgerTurn(ledger, sourceAgentId, sourceTurnId);
}

/** Select the oldest claimed, then oldest sequenced, observable source turn. */
export function selectObservableDeliveryTurn(
  ledger: DeliveryLedger,
  options: SelectObservableDeliveryTurnOptions,
): string | undefined {
  const candidates = new Map<string, { claimed: boolean; sequence: number }>();
  const addCandidate = (turnId: string, sequence: number) => {
    const candidate = {
      claimed: ledger.waitClaimedTurns.includes(deliveryTurnKey(options.sourceAgentId, turnId)),
      sequence,
    };
    const existing = candidates.get(turnId);
    if (!existing || sequence < existing.sequence) candidates.set(turnId, candidate);
  };
  for (const delivery of ledger.coordinationDeliveries) {
    if (
      delivery.destination_agent_id === options.destinationAgentId &&
      delivery.message.details.source_agent_id === options.sourceAgentId &&
      !options.waitHandedDeliveryIds.has(delivery.delivery_id)
    ) {
      addCandidate(delivery.message.details.source_turn_id, delivery.sequence);
    }
  }
  for (const delivery of ledger.terminalDeliveries) {
    if (
      delivery.destination_agent_id === options.destinationAgentId &&
      delivery.source_agent_id === options.sourceAgentId
    ) {
      addCandidate(delivery.source_turn_id, delivery.sequence ?? Number.MAX_SAFE_INTEGER);
    }
  }
  const retained = [...candidates.entries()].sort((left, right) => {
    if (left[1].claimed !== right[1].claimed) return left[1].claimed ? -1 : 1;
    return left[1].sequence - right[1].sequence;
  })[0]?.[0];
  return retained ?? options.activeTurnId ?? options.latestResultTurnId;
}

/** Remove delivery items and wait claims owned by any deleted agent subtree. */
export function pruneDeliveryLedgerAgents(
  ledger: DeliveryLedger,
  deletedAgentIds: readonly string[],
): DeliveryLedgerTransition {
  const belongsToDeletedSubtree = (agentId: string) =>
    deletedAgentIds.some(
      (deletedId) => agentId === deletedId || agentId.startsWith(`${deletedId}.`),
    );
  return createTransition({
    ...ledger,
    terminalDeliveries: ledger.terminalDeliveries.filter(
      (delivery) =>
        !belongsToDeletedSubtree(delivery.source_agent_id) &&
        !belongsToDeletedSubtree(delivery.destination_agent_id),
    ),
    coordinationDeliveries: ledger.coordinationDeliveries.filter(
      (delivery) =>
        !belongsToDeletedSubtree(delivery.message.details.source_agent_id) &&
        !belongsToDeletedSubtree(delivery.destination_agent_id),
    ),
    waitClaimedTurns: ledger.waitClaimedTurns.filter((key) => {
      const separatorIndex = key.indexOf("\u0000");
      const sourceAgentId = separatorIndex >= 0 ? key.slice(0, separatorIndex) : key;
      return !belongsToDeletedSubtree(sourceAgentId);
    }),
  });
}

/** Return one pending terminal delivery by source-turn identity. */
export function findTerminalDelivery(
  ledger: DeliveryLedger,
  sourceAgentId: string,
  sourceTurnId: string,
): PersistedDelivery | undefined {
  const key = deliveryTurnKey(sourceAgentId, sourceTurnId);
  const delivery = ledger.terminalDeliveries.find(
    (candidate) => deliveryTurnKey(candidate.source_agent_id, candidate.source_turn_id) === key,
  );
  return delivery ? cloneTerminalDelivery(delivery) : undefined;
}

/** Return one pending Coordination Message by stable delivery identity. */
export function findCoordinationDelivery(
  ledger: DeliveryLedger,
  deliveryId: string,
): PersistedCoordinationDelivery | undefined {
  const delivery = ledger.coordinationDeliveries.find(
    (candidate) => candidate.delivery_id === deliveryId,
  );
  return delivery ? cloneCoordinationDelivery(delivery) : undefined;
}

/** Report whether one source turn currently has a durable wait claim. */
export function isDeliveryLedgerTurnClaimed(
  ledger: DeliveryLedger,
  sourceAgentId: string,
  sourceTurnId: string,
): boolean {
  return ledger.waitClaimedTurns.includes(deliveryTurnKey(sourceAgentId, sourceTurnId));
}
