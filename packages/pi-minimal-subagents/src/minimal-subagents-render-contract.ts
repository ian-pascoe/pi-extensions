import type {
  AgentToolResult,
  MessageRenderer,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

/** Names of the six coordinator tools with custom transcript renderers. */
export type CoordinatorToolName =
  | "subagent"
  | "agent_message"
  | "subagent_wait"
  | "subagent_status"
  | "subagent_cancel"
  | "subagent_delete";

const RenderUsageSchema = Type.Object({
  input: Type.Number(),
  output: Type.Number(),
  cacheRead: Type.Number(),
  cacheWrite: Type.Number(),
  cacheWrite1h: Type.Optional(Type.Number()),
  reasoning: Type.Optional(Type.Number()),
  totalTokens: Type.Number(),
  cost: Type.Object({
    input: Type.Number(),
    output: Type.Number(),
    cacheRead: Type.Number(),
    cacheWrite: Type.Number(),
    total: Type.Number(),
  }),
});

const RenderLaunchContractSchema = Type.Object({
  session_context: Type.Optional(Type.String()),
  project_context: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  thinking_level: Type.Optional(Type.String()),
  delegation: Type.Optional(Type.String()),
  ordinary_tools: Type.Optional(Type.Array(Type.String())),
});

const RenderTurnResultSchema = Type.Object({
  agent_id: Type.Optional(Type.String()),
  turn_id: Type.Optional(Type.String()),
  status: Type.Optional(Type.String()),
  output: Type.Optional(Type.String()),
  error: Type.Optional(Type.String()),
  usage: Type.Optional(RenderUsageSchema),
  elapsed_ms: Type.Optional(Type.Number()),
});

const RenderRecentMessageSchema = Type.Object({
  source_agent_id: Type.Optional(Type.String()),
  content: Type.Optional(Type.String()),
});

/** Structurally parsed hierarchy status used only by transcript presentation. */
export const RenderStatusAgentSchema = Type.Object({
  agent_id: Type.Optional(Type.String()),
  parent_id: Type.Optional(Type.String()),
  state: Type.Optional(Type.String()),
  availability: Type.Optional(Type.String()),
  active_turn_id: Type.Optional(Type.String()),
  latest_turn: Type.Optional(
    Type.Object({
      turn_id: Type.Optional(Type.String()),
      status: Type.Optional(Type.String()),
    }),
  ),
  tools: Type.Optional(Type.Array(Type.String())),
  elapsed_ms: Type.Optional(Type.Number()),
  model: Type.Optional(Type.String()),
  thinking_level: Type.Optional(Type.String()),
  task: Type.Optional(Type.String()),
  child_count: Type.Optional(Type.Number()),
  session_file: Type.Optional(Type.String()),
  launch_contract: Type.Optional(RenderLaunchContractSchema),
  capability_ceiling: Type.Optional(Type.Array(Type.String())),
  spawn_entry_id: Type.Optional(Type.String()),
  recent_messages: Type.Optional(Type.Array(RenderRecentMessageSchema)),
  latest_result: Type.Optional(RenderTurnResultSchema),
  missing_dependencies: Type.Optional(Type.Array(Type.String())),
  unavailable_reason: Type.Optional(Type.String()),
  usage: Type.Optional(RenderUsageSchema),
});

const SpawnCallArgumentsSchema = Type.Object({
  task: Type.Optional(Type.String()),
  agent_id: Type.Optional(Type.String()),
  session_context: Type.Optional(Type.String()),
  project_context: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  thinking_level: Type.Optional(Type.String()),
  delegation: Type.Optional(Type.String()),
});
const MessageCallArgumentsSchema = Type.Object({
  agent_id: Type.Optional(Type.String()),
  message: Type.Optional(Type.String()),
  behavior: Type.Optional(Type.String()),
});
const WaitCallArgumentsSchema = Type.Object({ agent_id: Type.Optional(Type.String()) });
const StatusCallArgumentsSchema = Type.Object({ agent_id: Type.Optional(Type.String()) });
const ManagementCallArgumentsSchema = Type.Object({
  agent_id: Type.Optional(Type.String()),
  recursive: Type.Optional(Type.Boolean()),
});

const SpawnDetailsSchema = Type.Object({
  agent_id: Type.String(),
  turn_id: Type.String(),
  status: Type.String(),
  agent: Type.Optional(RenderStatusAgentSchema),
});
const CurrentMessageDetailsSchema = Type.Object({
  agent_id: Type.String(),
  message_id: Type.Optional(Type.String()),
  disposition: Type.String(),
  behavior: Type.Optional(Type.String()),
  error: Type.Optional(Type.String()),
});
const LegacyMessageDetailsSchema = Type.Object({
  agent_id: Type.String(),
  message_id: Type.Optional(Type.String()),
  delivered: Type.Boolean(),
  behavior: Type.Optional(Type.String()),
  error: Type.Optional(Type.String()),
});
const WaitMessageDetailsSchema = Type.Object({
  event: Type.Literal("message"),
  agent_id: Type.String(),
  turn_id: Type.String(),
  message_id: Type.String(),
  message: Type.String(),
  elapsed_ms: Type.Optional(Type.Number()),
  usage: Type.Optional(RenderUsageSchema),
});
const WaitTurnDetailsSchema = Type.Object({
  event: Type.Optional(Type.Literal("turn")),
  agent_id: Type.String(),
  turn_id: Type.Optional(Type.String()),
  status: Type.String(),
  output: Type.Optional(Type.String()),
  error: Type.Optional(Type.String()),
  elapsed_ms: Type.Optional(Type.Number()),
  usage: Type.Optional(RenderUsageSchema),
});
const StatusDetailsSchema = Type.Union([
  Type.Object({
    parent_id: Type.Optional(Type.String()),
    agents: Type.Array(RenderStatusAgentSchema),
  }),
  Type.Object({ agent: RenderStatusAgentSchema }),
]);
const CancelDetailsSchema = Type.Object({
  agent_id: Type.String(),
  recursive: Type.Boolean(),
  affected_agent_ids: Type.Array(Type.String()),
  cancelled_turn_ids: Type.Array(Type.String()),
});
const DeleteDetailsSchema = Type.Object({
  agent_id: Type.String(),
  recursive: Type.Boolean(),
  deleted_agent_ids: Type.Array(Type.String()),
  tombstoned_agent_ids: Type.Array(Type.String()),
  trashed_session_files: Type.Array(Type.String()),
  failures: Type.Array(
    Type.Object({
      agent_id: Type.String(),
      error: Type.String(),
    }),
  ),
});

const MessageRenderDetailsSchema = Type.Union([
  CurrentMessageDetailsSchema,
  LegacyMessageDetailsSchema,
]);
const WaitRenderDetailsSchema = Type.Union([WaitMessageDetailsSchema, WaitTurnDetailsSchema]);

export type SpawnCallArguments = Static<typeof SpawnCallArgumentsSchema>;
export type MessageCallArguments = Static<typeof MessageCallArgumentsSchema>;
export type WaitCallArguments = Static<typeof WaitCallArgumentsSchema>;
export type StatusCallArguments = Static<typeof StatusCallArgumentsSchema>;
export type ManagementCallArguments = Static<typeof ManagementCallArgumentsSchema>;
export type SpawnRenderDetails = Static<typeof SpawnDetailsSchema>;
export type MessageRenderDetails = Static<typeof MessageRenderDetailsSchema>;
export type WaitRenderDetails = Static<typeof WaitRenderDetailsSchema>;
export type StatusRenderDetails = Static<typeof StatusDetailsSchema>;
export type CancelRenderDetails = Static<typeof CancelDetailsSchema>;
export type DeleteRenderDetails = Static<typeof DeleteDetailsSchema>;
export type RenderStatusAgent = Static<typeof RenderStatusAgentSchema>;

/** Raw tool arguments supplied by Pi's tool-rendering interface. */
export type CoordinatorToolCallInput = Parameters<NonNullable<ToolDefinition["renderCall"]>>[0];

type CoordinatorMessageInput = Parameters<MessageRenderer>[0];

/** Parsed tool-call arguments tagged by their coordinator tool name. */
export type ParsedCoordinatorToolCall =
  | { toolName: "subagent"; args: SpawnCallArguments }
  | { toolName: "agent_message"; args: MessageCallArguments }
  | { toolName: "subagent_wait"; args: WaitCallArguments }
  | { toolName: "subagent_status"; args: StatusCallArguments }
  | { toolName: "subagent_cancel"; args: ManagementCallArguments }
  | { toolName: "subagent_delete"; args: ManagementCallArguments };

/** Parsed result details tagged by their coordinator tool name. */
export type ParsedCoordinatorToolResult =
  | { toolName: "subagent"; details: SpawnRenderDetails }
  | { toolName: "agent_message"; details: MessageRenderDetails }
  | { toolName: "subagent_wait"; details: WaitRenderDetails }
  | { toolName: "subagent_status"; details: StatusRenderDetails }
  | { toolName: "subagent_cancel"; details: CancelRenderDetails }
  | { toolName: "subagent_delete"; details: DeleteRenderDetails };

/** Parse one historical tool call without coercing or cleaning its captured arguments. */
export function parseCoordinatorToolCall(
  toolName: CoordinatorToolName,
  args: CoordinatorToolCallInput,
): ParsedCoordinatorToolCall | undefined {
  switch (toolName) {
    case "subagent":
      return Value.Check(SpawnCallArgumentsSchema, args) ? { toolName, args } : undefined;
    case "agent_message":
      return Value.Check(MessageCallArgumentsSchema, args) ? { toolName, args } : undefined;
    case "subagent_wait":
      return Value.Check(WaitCallArgumentsSchema, args) ? { toolName, args } : undefined;
    case "subagent_status":
      return Value.Check(StatusCallArgumentsSchema, args) ? { toolName, args } : undefined;
    case "subagent_cancel":
      return Value.Check(ManagementCallArgumentsSchema, args) ? { toolName, args } : undefined;
    case "subagent_delete":
      return Value.Check(ManagementCallArgumentsSchema, args) ? { toolName, args } : undefined;
  }
}

/** Parse one historical tool result exactly once at the transcript rendering boundary. */
export function parseCoordinatorToolResult(
  toolName: CoordinatorToolName,
  details: AgentToolResult<unknown>["details"],
): ParsedCoordinatorToolResult | undefined {
  switch (toolName) {
    case "subagent":
      return Value.Check(SpawnDetailsSchema, details) ? { toolName, details } : undefined;
    case "agent_message":
      return Value.Check(MessageRenderDetailsSchema, details) ? { toolName, details } : undefined;
    case "subagent_wait":
      return Value.Check(WaitRenderDetailsSchema, details) ? { toolName, details } : undefined;
    case "subagent_status":
      return Value.Check(StatusDetailsSchema, details) ? { toolName, details } : undefined;
    case "subagent_cancel":
      return Value.Check(CancelDetailsSchema, details) ? { toolName, details } : undefined;
    case "subagent_delete":
      return Value.Check(DeleteDetailsSchema, details) ? { toolName, details } : undefined;
  }
}

/** Coordinator message metadata accepted from current and historical Pi transcripts. */
export const CoordinatorMessageRenderDetailsSchema = Type.Object({
  source_agent_id: Type.Optional(Type.String()),
  destination_agent_id: Type.Optional(Type.String()),
  source_turn_id: Type.Optional(Type.String()),
  agent_id: Type.Optional(Type.String()),
  turn_id: Type.Optional(Type.String()),
  status: Type.Optional(Type.String()),
  elapsed_ms: Type.Optional(Type.Number()),
  usage: Type.Optional(RenderUsageSchema),
});

export type CoordinatorMessageRenderDetails = Static<typeof CoordinatorMessageRenderDetailsSchema>;

/** Parse optional custom-message details while tolerating legacy field names. */
export function parseCoordinatorMessageDetails(
  details: CoordinatorMessageInput["details"],
): CoordinatorMessageRenderDetails | undefined {
  return Value.Check(CoordinatorMessageRenderDetailsSchema, details) ? details : undefined;
}
