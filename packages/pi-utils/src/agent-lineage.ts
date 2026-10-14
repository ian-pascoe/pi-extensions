import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

/** Custom entry type of an Agent Lineage Record. */
export const AGENT_LINEAGE_ENTRY_TYPE = "pi-agent-lineage";

const Id = Type.String({ minLength: 1, maxLength: 256 });
const AgentLineageRecordSchema = Type.Object(
  {
    version: Type.Literal(1),
    sessionId: Id,
    rootSessionId: Id,
    agentId: Id,
    parentAgentId: Type.Union([Id, Type.Null()]),
  },
  { additionalProperties: false },
);

/** Where a Child Agent's session sits in its agent tree. */
export interface AgentLineage {
  /** The session that carries this record; a record copied into another session is ignored. */
  readonly sessionId: string;
  /** The root agent's session, which owns the whole agent tree. */
  readonly rootSessionId: string;
  /** This agent's ID, unique within its agent tree. */
  readonly agentId: string;
  /** The parent agent's ID, or null when the parent is the root session. */
  readonly parentAgentId: string | null;
}

export type AgentLineageRecord = Static<typeof AgentLineageRecordSchema>;

/** Entry data for `appendCustomEntry(AGENT_LINEAGE_ENTRY_TYPE, ...)`. */
export function agentLineageRecord(lineage: AgentLineage): AgentLineageRecord {
  const record = {
    version: 1 as const,
    sessionId: lineage.sessionId,
    rootSessionId: lineage.rootSessionId,
    agentId: lineage.agentId,
    parentAgentId: lineage.parentAgentId,
  };
  if (!Value.Check(AgentLineageRecordSchema, record))
    throw new Error("Invalid Agent Lineage: every ID must be 1–256 characters");
  return record;
}

/** Minimal shape of a recorded session entry, so parsed session files work as well as branches. */
export interface LineageEntryLike {
  readonly type: string;
  readonly customType?: string;
  readonly data?: unknown;
}

/** The latest valid record written by this session itself, or undefined when it has no lineage. */
export function readAgentLineage(
  sessionId: string,
  entries: readonly LineageEntryLike[],
): AgentLineage | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (
      entry?.type === "custom" &&
      entry.customType === AGENT_LINEAGE_ENTRY_TYPE &&
      Value.Check(AgentLineageRecordSchema, entry.data) &&
      entry.data.sessionId === sessionId
    ) {
      const { sessionId: own, rootSessionId, agentId, parentAgentId } = entry.data;
      return { sessionId: own, rootSessionId, agentId, parentAgentId };
    }
  }
  return undefined;
}
