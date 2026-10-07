import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import {
  riskCategorySchema,
  riskLevelSchema,
  userAuthorizationSchema,
} from "./guardian-assessment.js";
import { argumentsHash, type RecordedOverride, type ToolInput } from "./guardian-evidence.js";

/** Custom session entry recording one Guardian Review; never part of model context. */
export const reviewEntryType = "pi-guardian-review";

const nullableNumber = Type.Union([Type.Number(), Type.Null()]);
const nullableString = Type.Union([Type.String(), Type.Null()]);

/**
 * How a Guardian Review ended for its call. `allowed` and `rejected` are the Decision Table's
 * Outcome; `failed` is a Review Failure, `aborted` followed the turn's abort, and `unused` is a
 * review started ahead of its call and then not used: the call never reached Guardian's
 * `tool_call` handler, or something the review depended on changed before it did.
 */
export const auditResultSchema = Type.Union([
  Type.Literal("allowed"),
  Type.Literal("rejected"),
  Type.Literal("failed"),
  Type.Literal("aborted"),
  Type.Literal("unused"),
]);
export type AuditResult = Static<typeof auditResultSchema>;

/** Token usage of one Guardian Review, summed over its attempts. */
export const reviewUsageSchema = Type.Object({
  input: Type.Number(),
  output: Type.Number(),
  cacheRead: Type.Number(),
  cacheWrite: Type.Number(),
  total: Type.Number(),
});
export type ReviewUsage = Static<typeof reviewUsageSchema>;

export const reviewEntrySchema = Type.Object({
  version: Type.Literal(1),
  toolName: Type.String(),
  toolCallId: Type.String(),
  parentToolCallId: nullableString,
  /** The Reviewed Call's arguments as reviewed, bounded for the journal. */
  arguments: Type.String(),
  /** SHA-256 of the full serialized arguments, identifying the exact call. */
  argumentsSha256: Type.String(),
  /** The risk as the Guardian stated it. */
  risk: Type.Union([riskLevelSchema, Type.Null()]),
  /** The Risk Category the Guardian named, when valid. */
  riskCategory: Type.Optional(riskCategorySchema),
  /** Set when a `high` or `critical` risk without a valid Risk Category was decided as `medium`. */
  downgraded: Type.Optional(Type.Boolean()),
  authorization: Type.Union([userAuthorizationSchema, Type.Null()]),
  result: auditResultSchema,
  rationale: nullableString,
  failure: nullableString,
  /** True when the call ran because the user allowed it interactively. */
  userOverride: Type.Boolean(),
  /** True when the call was blocked. */
  blocked: Type.Boolean(),
  model: nullableString,
  durationMs: Type.Number(),
  usage: Type.Union([reviewUsageSchema, Type.Null()]),
  cost: nullableNumber,
  /**
   * Calibration sample: Guardian's chars/4 estimate of the first request and the prompt tokens
   * its provider reported. Each model's token factor is derived from these on the branch.
   */
  estimatedPromptTokens: Type.Optional(Type.Number()),
  promptTokens: Type.Optional(Type.Number()),
  /**
   * For allowed calls: whether the call ran. Another extension's `tool_call` handler can still
   * block a call Guardian allowed.
   */
  executed: Type.Optional(Type.Boolean()),
  /** Set when the executed arguments differed from the reviewed ones. */
  argumentDrift: Type.Optional(Type.Boolean()),
  /** Set when a malformed reply was followed by one corrective retry. */
  retried: Type.Optional(Type.Boolean()),
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
    if (data.result === "allowed") totals.allowed++;
    if (data.result === "rejected") totals.rejected++;
    if (data.result === "failed") {
      totals.failed++;
      totals.lastError = data.failure;
    }
    if (data.result === "aborted") totals.aborted++;
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
        decision: `The user interactively allowed one call after ${data.result === "rejected" ? "a Rejection" : "a Review Failure"}.`,
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

/** Calibration samples for one Guardian model on the branch, in order. */
export function calibrationSamples(
  branch: readonly SessionEntry[],
  model: string,
): { estimated: number; reported: number }[] {
  return reviewEntries(branch).flatMap(({ data }) =>
    data.model === model &&
    data.estimatedPromptTokens !== undefined &&
    data.promptTokens !== undefined
      ? [{ estimated: data.estimatedPromptTokens, reported: data.promptTokens }]
      : [],
  );
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
