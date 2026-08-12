import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type TSchema } from "typebox";
import { THINKING_LEVELS } from "./minimal-subagents-capabilities.js";

const SessionContextSchema = StringEnum(["inherit", "compact", "omit"] as const);
const ProjectContextSchema = StringEnum(["inherit", "omit"] as const);
const DelegationSchema = StringEnum(["none", "fanout"] as const);
const ThinkingLevelSchema = StringEnum(THINKING_LEVELS);
const ToolSelectionSchema = Type.Union([
  StringEnum(["none", "read", "modify"] as const),
  Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }),
]);
const FRIENDLY_AGENT_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$";
const CANONICAL_AGENT_ID_PATTERN =
  "^(?:root\\.)?[A-Za-z0-9][A-Za-z0-9_-]{0,63}(?:\\.[A-Za-z0-9][A-Za-z0-9_-]{0,63})*$";

function canonicalAgentIdSchema(description?: string) {
  return Type.String({ minLength: 1, pattern: CANONICAL_AGENT_ID_PATTERN, description });
}

/** Build all six strict TypeBox schemas, including the refreshed runtime model enum. */
export function createCoordinatorToolSchemas(modelIds: readonly string[]) {
  const explicitModelSchema: TSchema =
    modelIds.length > 0 ? StringEnum(modelIds as [string, ...string[]]) : Type.Never();
  return {
    subagent: Type.Object({
      task: Type.String({ minLength: 1, description: "Task for the persistent child agent" }),
      agent_id: Type.Optional(
        Type.String({
          pattern: FRIENDLY_AGENT_ID_PATTERN,
          description:
            "Friendly peer-unique ID segment; a root child uses this segment as its canonical ID",
        }),
      ),
      session_context: Type.Optional(SessionContextSchema),
      project_context: Type.Optional(ProjectContextSchema),
      model: Type.Optional(explicitModelSchema),
      thinking_level: Type.Optional(ThinkingLevelSchema),
      tools: Type.Optional(ToolSelectionSchema),
      delegation: Type.Optional(DelegationSchema),
    }),
    agent_message: Type.Object({
      agent_id: Type.Optional(
        canonicalAgentIdSchema(
          "Direct parent, sibling, or child canonical agent ID, or parent alias",
        ),
      ),
      message: Type.String({ minLength: 1 }),
    }),
    subagent_wait: Type.Object({
      agent_id: canonicalAgentIdSchema("Direct child canonical agent ID"),
      timeout_ms: Type.Optional(Type.Integer({ minimum: 0 })),
    }),
    subagent_status: Type.Object({
      agent_id: Type.Optional(canonicalAgentIdSchema("Direct child canonical agent ID")),
    }),
    subagent_cancel: Type.Object({
      agent_id: canonicalAgentIdSchema("Direct child canonical agent ID"),
      recursive: Type.Optional(Type.Boolean()),
    }),
    subagent_delete: Type.Object({
      agent_id: canonicalAgentIdSchema("Direct child canonical agent ID"),
      recursive: Type.Optional(Type.Boolean()),
    }),
  };
}
