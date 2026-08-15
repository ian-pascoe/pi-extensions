import { Type, type Static } from "typebox";

/** Parses the first identity record that promotes a child session. */
export const ChildSessionIdentityRecordSchema = Type.Object({
  version: Type.Literal(1),
  original_root_session_id: Type.String(),
  canonical_agent_id: Type.String(),
  direct_parent_id: Type.String(),
  created_at: Type.String(),
});

/** Parses source provenance appended to each fork clone generation. */
export const ForkCloneProvenanceRecordSchema = Type.Object({
  version: Type.Literal(1),
  source_root_session_id: Type.String(),
  source_agent_id: Type.String(),
  source_session_id: Type.String(),
});

/** Parses destination-root ownership for the current fork clone generation. */
export const ForkOwnershipRecordSchema = Type.Object({
  version: Type.Literal(1),
  source_root_session_id: Type.String(),
  source_agent_id: Type.String(),
  source_session_id: Type.String(),
  destination_root_session_id: Type.String(),
  clone_session_id: Type.String(),
  direct_parent_id: Type.String(),
});

/** Parses durable custom-message and wait-tool Delivery Evidence details. */
export const DeliveryEvidenceDetailsSchema = Type.Object({
  event: Type.Optional(Type.String()),
  source_agent_id: Type.String(),
  source_turn_id: Type.String(),
  delivery_id: Type.Optional(Type.String()),
  message_id: Type.Optional(Type.String()),
});

export type ChildSessionIdentityRecord = Static<typeof ChildSessionIdentityRecordSchema>;
export type ForkCloneProvenanceRecord = Static<typeof ForkCloneProvenanceRecordSchema>;
export type ForkOwnershipRecord = Static<typeof ForkOwnershipRecordSchema>;
