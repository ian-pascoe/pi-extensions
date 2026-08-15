import type { JsonValue } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

/** Establishes Pi's recursive JSON owner type before Registry envelope parsing. */
export const RegistryJsonValueWireSchema = Type.Unsafe<JsonValue>({});

const NonnegativeNumberSchema = Type.Number({ minimum: 0 });
const NonEmptyStringSchema = Type.String({ minLength: 1 });
const TurnStatusSchema = Type.Union([
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
  Type.Literal("interrupted"),
]);
const ThinkingLevelSchema = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
  Type.Literal("max"),
]);

/** Parses persisted model usage without coercion. */
export const RegistryUsageWireSchema = Type.Object({
  input: NonnegativeNumberSchema,
  output: NonnegativeNumberSchema,
  cacheRead: NonnegativeNumberSchema,
  cacheWrite: NonnegativeNumberSchema,
  totalTokens: NonnegativeNumberSchema,
  cacheWrite1h: Type.Optional(NonnegativeNumberSchema),
  reasoning: Type.Optional(NonnegativeNumberSchema),
  cost: Type.Object({
    input: NonnegativeNumberSchema,
    output: NonnegativeNumberSchema,
    cacheRead: NonnegativeNumberSchema,
    cacheWrite: NonnegativeNumberSchema,
    total: NonnegativeNumberSchema,
  }),
});

/** Parses persisted terminal turn results without coercion. */
export const RegistryTurnResultWireSchema = Type.Object({
  agent_id: NonEmptyStringSchema,
  turn_id: NonEmptyStringSchema,
  status: TurnStatusSchema,
  output: Type.String(),
  error: Type.Optional(Type.String()),
  usage: Type.Optional(RegistryUsageWireSchema),
  elapsed_ms: Type.Optional(NonnegativeNumberSchema),
});

const ToolSelectionWireSchema = Type.Union([
  Type.Literal("none"),
  Type.Literal("read"),
  Type.Literal("modify"),
  Type.Array(NonEmptyStringSchema),
]);

/** Parses persisted immutable Launch Contracts without coercion. */
export const RegistryLaunchContractWireSchema = Type.Object({
  session_context: Type.Union([
    Type.Literal("inherit"),
    Type.Literal("compact"),
    Type.Literal("omit"),
  ]),
  project_context: Type.Union([Type.Literal("inherit"), Type.Literal("omit")]),
  model: Type.String(),
  thinking_level: ThinkingLevelSchema,
  tools: Type.Optional(ToolSelectionWireSchema),
  ordinary_tools: Type.Array(NonEmptyStringSchema),
  delegation: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("fanout")])),
});

/** Parses the recent-message projection stored on one agent. */
export const RegistryRecentMessageWireSchema = Type.Object({
  source_agent_id: NonEmptyStringSchema,
  turn_id: NonEmptyStringSchema,
  content: Type.String(),
});

/** Parses one persisted Registry agent without applying cross-field semantics. */
export const RegistryAgentWireSchema = Type.Object({
  agent_id: NonEmptyStringSchema,
  friendly_id: NonEmptyStringSchema,
  parent_id: NonEmptyStringSchema,
  created_at: Type.String(),
  task: Type.Optional(Type.String()),
  latest_activity_at: Type.Optional(Type.String()),
  spawn_entry_id: NonEmptyStringSchema,
  session_file: Type.Optional(NonEmptyStringSchema),
  session_id: Type.Optional(NonEmptyStringSchema),
  session_leaf_id: Type.Optional(NonEmptyStringSchema),
  clone_error: Type.Optional(NonEmptyStringSchema),
  launch_contract: RegistryLaunchContractWireSchema,
  capability_ceiling: Type.Array(NonEmptyStringSchema),
  active_turn_id: Type.Optional(NonEmptyStringSchema),
  active_turn_started_at: Type.Optional(Type.String()),
  latest_result: Type.Optional(RegistryTurnResultWireSchema),
  availability: Type.Union([Type.Literal("available"), Type.Literal("unavailable")]),
  missing_dependencies: Type.Array(NonEmptyStringSchema),
  unavailable_reason: Type.Optional(NonEmptyStringSchema),
  recent_messages: Type.Array(RegistryRecentMessageWireSchema),
  deleted: Type.Optional(Type.Boolean()),
});

/** Parses one terminal Delivery Ledger item without applying ownership semantics. */
export const RegistryTerminalDeliveryWireSchema = Type.Object({
  source_agent_id: NonEmptyStringSchema,
  source_turn_id: NonEmptyStringSchema,
  destination_agent_id: NonEmptyStringSchema,
  path: Type.Union([Type.Literal("wait"), Type.Literal("message")]),
  settled: Type.Boolean(),
  sequence: Type.Optional(Type.Number()),
  result: Type.Optional(RegistryTurnResultWireSchema),
  error: Type.Optional(Type.String()),
});

const CoordinatorMessageDetailsWireSchema = Type.Object({
  source_agent_id: NonEmptyStringSchema,
  destination_agent_id: Type.Optional(NonEmptyStringSchema),
  source_turn_id: NonEmptyStringSchema,
  message_id: NonEmptyStringSchema,
  delivery_id: Type.Optional(NonEmptyStringSchema),
  status: Type.Optional(TurnStatusSchema),
  elapsed_ms: Type.Optional(NonnegativeNumberSchema),
  usage: Type.Optional(RegistryUsageWireSchema),
});

/** Parses the persisted Coordination Message envelope. */
export const RegistryCoordinatorMessageWireSchema = Type.Object({
  customType: Type.Union([
    Type.Literal("minimal-subagents.message"),
    Type.Literal("minimal-subagents.result"),
  ]),
  content: Type.String(),
  details: CoordinatorMessageDetailsWireSchema,
});

/** Parses one Coordination Message Delivery Ledger item. */
export const RegistryCoordinationDeliveryWireSchema = Type.Object({
  delivery_id: NonEmptyStringSchema,
  sequence: Type.Number(),
  destination_agent_id: NonEmptyStringSchema,
  path: Type.Union([Type.Literal("wait"), Type.Literal("message")]),
  settled: Type.Boolean(),
  message: RegistryCoordinatorMessageWireSchema,
  error: Type.Optional(Type.String()),
});

/** Parses a persisted Registry checkpoint before semantic validation. */
export const RegistrySnapshotWireSchema = Type.Object({
  agents: Type.Array(RegistryAgentWireSchema),
  tombstones: Type.Array(NonEmptyStringSchema),
  deliveries: Type.Array(RegistryTerminalDeliveryWireSchema),
  coordination_deliveries: Type.Optional(Type.Array(RegistryCoordinationDeliveryWireSchema)),
  wait_claimed_turns: Type.Optional(Type.Array(NonEmptyStringSchema)),
  next_delivery_sequence: Type.Optional(Type.Number()),
});

/** Parses loose envelope fields so diagnostics retain their stable ownership. */
export const RegistryLooseEnvelopeWireSchema = Type.Object({
  version: Type.Unknown(),
  root_session_id: NonEmptyStringSchema,
  timestamp: Type.String(),
  event: Type.Unknown(),
});

/** Parses the event discriminant independently from its payload. */
export const RegistryEventDiscriminantWireSchema = Type.Object({
  event: Type.String(),
});

/** Parses the common Registry envelope fields before event-specific parsing. */
export const RegistryEnvelopeWireSchema = Type.Object({
  version: Type.Union([Type.Literal(1), Type.Literal(2)]),
  root_session_id: NonEmptyStringSchema,
  timestamp: Type.String(),
  event: Type.String(),
});

/** Parses the root identity early enough to ignore foreign-root records silently. */
export const RegistryRootProbeWireSchema = Type.Object({
  root_session_id: Type.String(),
});

/** Parses the checkpoint event payload. */
export const RegistryCheckpointEventWireSchema = Type.Object({
  snapshot: RegistrySnapshotWireSchema,
});

/** Parses the agent-created event payload. */
export const RegistryAgentCreatedEventWireSchema = Type.Object({
  agent: RegistryAgentWireSchema,
});

/** Parses the turn-started event payload. */
export const RegistryTurnStartedEventWireSchema = Type.Object({
  agent_id: NonEmptyStringSchema,
  turn_id: NonEmptyStringSchema,
  started_at: Type.String(),
});

/** Parses the turn-settled event payload. */
export const RegistryTurnSettledEventWireSchema = Type.Object({
  result: RegistryTurnResultWireSchema,
  settled_at: Type.Optional(Type.String()),
  session_leaf_id: Type.Optional(NonEmptyStringSchema),
});

/** Parses the terminal delivery-pending event payload. */
export const RegistryDeliveryPendingEventWireSchema = Type.Object({
  delivery: RegistryTerminalDeliveryWireSchema,
});

/** Parses the terminal delivery-settled event payload. */
export const RegistryDeliverySettledEventWireSchema = Type.Object({
  source_agent_id: NonEmptyStringSchema,
  source_turn_id: NonEmptyStringSchema,
  error: Type.Optional(Type.String()),
});

/** Parses the terminal delivery-pruned event payload. */
export const RegistryDeliveryPrunedEventWireSchema = Type.Object({
  source_agent_id: NonEmptyStringSchema,
  source_turn_id: NonEmptyStringSchema,
  reason: Type.Literal("retention-limit"),
});

/** Parses the Coordination Message delivery-pending event payload. */
export const RegistryCoordinationPendingEventWireSchema = Type.Object({
  delivery: RegistryCoordinationDeliveryWireSchema,
});

/** Parses the Coordination Message delivery-settled event payload. */
export const RegistryCoordinationSettledEventWireSchema = Type.Object({
  delivery_id: NonEmptyStringSchema,
  error: Type.Optional(Type.String()),
});

/** Parses the wait-claim and wait-release event payload. */
export const RegistryDeliveryTurnEventWireSchema = Type.Object({
  source_agent_id: NonEmptyStringSchema,
  source_turn_id: NonEmptyStringSchema,
});

/** Parses the recent-message activity event payload. */
export const RegistryMessageRecordedEventWireSchema = Type.Object({
  agent_id: NonEmptyStringSchema,
  message: RegistryRecentMessageWireSchema,
  recorded_at: Type.Optional(Type.String()),
});

/** Parses the subtree-deletion event payload. */
export const RegistryAgentDeletedEventWireSchema = Type.Object({
  agent_ids: Type.Array(NonEmptyStringSchema),
});

export type RegistryAgentWire = Static<typeof RegistryAgentWireSchema>;
export type RegistryCoordinationDeliveryWire = Static<
  typeof RegistryCoordinationDeliveryWireSchema
>;
export type RegistryCoordinatorMessageWire = Static<typeof RegistryCoordinatorMessageWireSchema>;
export type RegistryLaunchContractWire = Static<typeof RegistryLaunchContractWireSchema>;
export type RegistryRecentMessageWire = Static<typeof RegistryRecentMessageWireSchema>;
export type RegistrySnapshotWire = Static<typeof RegistrySnapshotWireSchema>;
export type RegistryTerminalDeliveryWire = Static<typeof RegistryTerminalDeliveryWireSchema>;
export type RegistryTurnResultWire = Static<typeof RegistryTurnResultWireSchema>;
