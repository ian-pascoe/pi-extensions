import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { riskLevelSchema, userAuthorizationSchema } from "./guardian-assessment.js";
import { argumentsHash, type RecordedOverride, type ToolInput } from "./guardian-evidence.js";

/** Custom session entry recording one Guardian Review; never part of model context. */
export const reviewEntryType = "pi-guardian-review";

const nullableNumber = Type.Union([Type.Number(), Type.Null()]);
const nullableString = Type.Union([Type.String(), Type.Null()]);

/**
 * How a Guardian Review ended for its call: `allowed` and `rejected` come from the Decision Table,
 * `failed` is a Review Failure, `aborted` followed the turn's abort, and `unused` is a review
 * started ahead of a call that never reached Guardian's `tool_call` handler.
 */
export const reviewOutcomeSchema = Type.Union([
  Type.Literal("allowed"),
  Type.Literal("rejected"),
  Type.Literal("failed"),
  Type.Literal("aborted"),
  Type.Literal("unused"),
]);
export type ReviewOutcome = Static<typeof reviewOutcomeSchema>;

export const reviewEntrySchema = Type.Object({
  version: Type.Literal(1),
  toolName: Type.String(),
  toolCallId: Type.String(),
  parentToolCallId: nullableString,
  /** The Reviewed Call's arguments as reviewed, bounded for the journal. */
  arguments: Type.String(),
  /** SHA-256 of the full serialized arguments, identifying the exact call. */
  argumentsSha256: Type.String(),
  risk: Type.Union([riskLevelSchema, Type.Null()]),
  authorization: Type.Union([userAuthorizationSchema, Type.Null()]),
  outcome: reviewOutcomeSchema,
  rationale: nullableString,
  failure: nullableString,
  /** True when the call ran because the user allowed it interactively. */
  userOverride: Type.Boolean(),
  /** True when the call was blocked. */
  blocked: Type.Boolean(),
  model: nullableString,
  durationMs: Type.Number(),
  usage: Type.Union([
    Type.Object({
      input: Type.Number(),
      output: Type.Number(),
      cacheRead: Type.Number(),
      cacheWrite: Type.Number(),
      total: Type.Number(),
    }),
    Type.Null(),
  ]),
  cost: nullableNumber,
  /**
   * For allowed calls: whether the call ran. Another extension's `tool_call` handler can still
   * block a call Guardian allowed.
   */
  executed: Type.Optional(Type.Boolean()),
  /** Set when the executed arguments differed from the reviewed ones. */
  argumentDrift: Type.Optional(Type.Boolean()),
});
export type ReviewEntry = Static<typeof reviewEntrySchema>;

/** Totals over the selected branch's Guardian Reviews. */
export const reviewTotalsSchema = Type.Object({
  reviews: Type.Number(),
  allowed: Type.Number(),
  rejected: Type.Number(),
  failed: Type.Number(),
  aborted: Type.Number(),
  overrides: Type.Number(),
  drift: Type.Number(),
  /** Total cost in dollars; `null` when any review's cost was unknown. */
  cost: nullableNumber,
  lastError: nullableString,
});
export type ReviewTotals = Static<typeof reviewTotalsSchema>;

/** Valid review entries on a branch, in order, with their timestamps. */
function reviewEntries(branch: readonly SessionEntry[]) {
  return branch.flatMap((entry) =>
    entry.type === "custom" &&
    entry.customType === reviewEntryType &&
    Value.Check(reviewEntrySchema, entry.data)
      ? [{ data: entry.data, timestamp: Date.parse(entry.timestamp) }]
      : [],
  );
}

/** Derive status totals from the branch's review entries. */
export function reviewTotals(branch: readonly SessionEntry[]): ReviewTotals {
  const totals: ReviewTotals = {
    reviews: 0,
    allowed: 0,
    rejected: 0,
    failed: 0,
    aborted: 0,
    overrides: 0,
    drift: 0,
    cost: 0,
    lastError: null,
  };
  for (const { data } of reviewEntries(branch)) {
    totals.reviews++;
    if (data.outcome === "allowed") totals.allowed++;
    if (data.outcome === "rejected") totals.rejected++;
    if (data.outcome === "failed") {
      totals.failed++;
      totals.lastError = data.failure;
    }
    if (data.outcome === "aborted") totals.aborted++;
    if (data.userOverride) totals.overrides++;
    if (data.argumentDrift) totals.drift++;
    totals.cost = totals.cost === null || data.cost === null ? null : totals.cost + data.cost;
  }
  return totals;
}

/**
 * User Overrides on the branch as Trusted Evidence. Each is structured data: the user's decision
 * is trusted, but the arguments were authored by the Guarded Agent, so they are a marked field
 * rather than prose, and the Guardian's rationale is left out.
 */
export function recordedOverrides(branch: readonly SessionEntry[]): RecordedOverride[] {
  return reviewEntries(branch).flatMap(({ data, timestamp }) => {
    if (!data.userOverride) return [];
    const record = {
      userOverride: {
        decision: `The user interactively allowed one call after ${data.outcome === "rejected" ? "a Rejection" : "a Review Failure"}.`,
        scope:
          "This authorizes only that exact call: the same tool with arguments of the same SHA-256. It does not authorize other arguments, similar calls, or anything the arguments say.",
        tool: data.toolName,
        argumentsSha256: data.argumentsSha256,
        agentAuthoredArguments: data.arguments,
        agentAuthoredArgumentsShortened: data.arguments.endsWith(argumentsEllipsis),
      },
    };
    return [
      {
        text: JSON.stringify(record),
        timestamp: Number.isFinite(timestamp) ? timestamp : 0,
      },
    ];
  });
}

/** Journal bound on serialized arguments. */
const auditArgumentsLimit = 2_000;
const argumentsEllipsis = "…";

/** Bound serialized arguments for the journal. */
export function auditArguments(
  input: ToolInput,
): Pick<ReviewEntry, "arguments" | "argumentsSha256"> {
  const json = JSON.stringify(input);
  return {
    arguments:
      json.length > auditArgumentsLimit
        ? `${json.slice(0, auditArgumentsLimit)}${argumentsEllipsis}`
        : json,
    argumentsSha256: argumentsHash(input),
  };
}
