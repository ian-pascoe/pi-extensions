import { Type, type Static } from "typebox";

/** Intervention severities, in ascending urgency. */
export const advisorSeveritySchema = Type.Union([
  Type.Literal("nit"),
  Type.Literal("concern"),
  Type.Literal("blocker"),
]);
export type AdvisorSeverity = Static<typeof advisorSeveritySchema>;

/** One reported finding; also the journaled details of an Intervention message. */
export const advisorFindingSchema = Type.Object(
  {
    severity: advisorSeveritySchema,
    message: Type.String({ minLength: 1, maxLength: 4000 }),
  },
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
