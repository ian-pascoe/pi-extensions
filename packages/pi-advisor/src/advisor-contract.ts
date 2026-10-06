import { Type, type Static } from "typebox";

/** Intervention severities, in ascending urgency. */
export const advisorSeveritySchema = Type.Union([
  Type.Literal("nit"),
  Type.Literal("concern"),
  Type.Literal("blocker"),
]);
export type AdvisorSeverity = Static<typeof advisorSeveritySchema>;

/** What a finding cites from the Review Evidence it was judged against. */
export const advisorEvidenceSchema = Type.Object(
  {
    refs: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 64 }), {
        maxItems: 8,
        description:
          "Tool-Call References (the `ref` of a tool call or its result in the supplied evidence) that show the defect",
      }),
    ),
    quote: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 1000,
        description: "A short verbatim quote from the supplied evidence that shows the defect",
      }),
    ),
  },
  { additionalProperties: false },
);
export type AdvisorEvidence = Static<typeof advisorEvidenceSchema>;

const findingFields = {
  severity: advisorSeveritySchema,
  message: Type.String({ minLength: 1, maxLength: 4000 }),
};

/**
 * One finding; also the journaled details of an Intervention message. `evidence` is absent from
 * Interventions recorded before findings cited evidence, and from legacy single-finding reports.
 */
export const advisorFindingSchema = Type.Object(
  { ...findingFields, evidence: Type.Optional(advisorEvidenceSchema) },
  { additionalProperties: false },
);
export type AdvisorFinding = Static<typeof advisorFindingSchema>;

const knownCost = Type.Union([Type.Number(), Type.Null()]);
/**
 * Native usage cost of Reviews since the Advisor was loaded, across Advisor Session rebuilds:
 * the number of Reviews, the last one's cost, and their total. A cost is null when unknown;
 * the total stays null once any Review's cost was unknown.
 */
export const advisorReviewCostSchema = Type.Object({
  reviews: Type.Number(),
  last: knownCost,
  total: knownCost,
});
export type AdvisorReviewCost = Static<typeof advisorReviewCostSchema>;

/** A finding as `advisor_report` accepts it: every finding cites its evidence. */
export const advisorReportFindingSchema = Type.Object(
  {
    ...findingFields,
    evidence: Type.Object(advisorEvidenceSchema.properties, {
      additionalProperties: false,
      description:
        "Evidence for a concrete defect in completed work: at least one Tool-Call Reference or a verbatim quote",
    }),
  },
  { additionalProperties: false },
);

/** Observer lifecycle state reported by its `status`. */
export const advisorObserverStateSchema = Type.Union([
  Type.Literal("disabled"),
  Type.Literal("armed"),
  Type.Literal("reviewing"),
  Type.Literal("consulting"),
  Type.Literal("paused"),
]);
export type AdvisorObserverState = Static<typeof advisorObserverStateSchema>;

/** State recorded in status entries; private Advisor Sessions cannot host an Advisor. */
export const advisorStateSchema = Type.Union([advisorObserverStateSchema, Type.Literal("private")]);
export type AdvisorState = Static<typeof advisorStateSchema>;
