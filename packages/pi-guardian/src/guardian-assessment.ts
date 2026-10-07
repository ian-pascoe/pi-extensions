import { isDeepStrictEqual } from "node:util";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export const riskLevelSchema = Type.Union([
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("critical"),
]);
export type RiskLevel = Static<typeof riskLevelSchema>;
export const userAuthorizationSchema = Type.Union([
  Type.Literal("unknown"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
]);
export type UserAuthorization = Static<typeof userAuthorizationSchema>;

/**
 * Risk Categories: the only grounds for `high` or `critical` risk. A `high` or `critical`
 * assessment without a valid one is decided as `medium`.
 */
export const riskCategorySchema = Type.Union([
  Type.Literal("data_egress"),
  Type.Literal("credential_access"),
  Type.Literal("destruction"),
  Type.Literal("persistence"),
  Type.Literal("sensitive_path"),
  Type.Literal("safety_weakening"),
  Type.Literal("remote_code"),
  Type.Literal("unreviewed_execution"),
  Type.Literal("security_policy"),
]);
export type RiskCategory = Static<typeof riskCategorySchema>;
export const riskCategories: readonly RiskCategory[] = riskCategorySchema.anyOf.map(
  (literal) => literal.const,
);

/**
 * The Risk Categories a review may name: `security_policy` only when the user configured a
 * Security Policy for the call to violate.
 */
export function validRiskCategories(securityPolicy: boolean): readonly RiskCategory[] {
  return securityPolicy
    ? riskCategories
    : riskCategories.filter((name) => name !== "security_policy");
}

/** A stated category in canonical form: `Data-Egress` and `data egress` mean `data_egress`. */
function normalizedCategory(value: string | null | undefined): string | undefined {
  const text = value
    ?.trim()
    .toLowerCase()
    .replaceAll(/[\s-]+/g, "_");
  return text || undefined;
}

/**
 * The Guardian's required answer; extra fields are tolerated and ignored. The rationale and Risk
 * Category are optional and may be `null`: the category is given only for `high` or `critical`
 * risk, and unless `verbose` is on, so is the rationale. An unknown category is kept out rather
 * than failing the parse; the review asks again once for a `high` or `critical` assessment
 * without a valid one.
 */
export const assessmentSchema = Type.Object({
  risk_level: riskLevelSchema,
  user_authorization: userAuthorizationSchema,
  risk_category: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  rationale: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});
/** One Guardian Review's assessment, with the risk as the Guardian stated it. */
export interface Assessment {
  risk: RiskLevel;
  authorization: UserAuthorization;
  /** The valid Risk Category the Guardian named, if any. */
  category: RiskCategory | undefined;
  rationale: string;
}

/** Whether a `high` or `critical` assessment names no valid Risk Category. */
export function uncategorized(assessment: Assessment): boolean {
  return (
    (assessment.risk === "high" || assessment.risk === "critical") &&
    assessment.category === undefined
  );
}

/** The risk the Decision Table uses: `medium` for an uncategorized `high` or `critical`. */
export function decidedRisk(assessment: Assessment): RiskLevel {
  return uncategorized(assessment) ? "medium" : assessment.risk;
}

/** Outcome of a Guardian Review, derived only by the Decision Table. */
export type Outcome = "allowed" | "rejected";

/**
 * Decision Table: `low` and `medium` risk are allowed; `high` risk is allowed only with at least
 * `medium` User Authorization; `critical` risk is always rejected.
 */
export function decide(risk: RiskLevel, authorization: UserAuthorization): Outcome {
  if (risk === "low" || risk === "medium") return "allowed";
  if (risk === "high" && (authorization === "medium" || authorization === "high")) return "allowed";
  return "rejected";
}

/** Every top-level `{…}` span in a reply, skipping braces inside JSON strings. */
function objectSpans(text: string): string[] {
  const spans: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  // Every structural character is ASCII, so UTF-16 indexes are safe here.
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"' && depth > 0) inString = true;
    else if (character === "{") {
      if (depth++ === 0) start = index;
    } else if (character === "}" && depth > 0 && --depth === 0)
      spans.push(text.slice(start, index + 1));
  }
  return spans;
}

/** Valid assessments in a reply: the whole text, or each top-level JSON object in it. */
function assessments(text: string, categories: readonly RiskCategory[]): Assessment[] {
  const found: Assessment[] = [];
  for (const candidate of [text.trim(), ...objectSpans(text)]) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!Value.Check(assessmentSchema, parsed)) continue;
    const stated = normalizedCategory(parsed.risk_category);
    found.push({
      risk: parsed.risk_level,
      authorization: parsed.user_authorization,
      category: categories.find((name) => name === stated),
      rationale: parsed.rationale?.trim() ?? "",
    });
  }
  return found;
}

/**
 * Parse a Guardian reply; throws a Review Failure message unless it holds exactly one valid
 * assessment. Repeating the same assessment is tolerated; differing assessments are ambiguous.
 * A category outside `categories` (by default every one but `security_policy`) is left out.
 */
export function parseAssessment(
  text: string,
  categories: readonly RiskCategory[] = validRiskCategories(false),
): Assessment {
  const [first, ...rest] = assessments(text, categories);
  if (!first)
    throw new Error("Guardian returned malformed output (expected the assessment JSON object)");
  if (rest.some((other) => !isDeepStrictEqual(other, first)))
    throw new Error(
      "Guardian returned malformed output (more than one differing assessment JSON object)",
    );
  return first;
}

/** The risk with its Risk Category, such as `critical (data_egress)`. */
export function riskLabel(assessment: Pick<Assessment, "risk" | "category">): string {
  return assessment.category ? `${assessment.risk} (${assessment.category})` : assessment.risk;
}

/** The assessment's rationale, or a fixed reason when the Guardian gave none. */
export function statedRationale(assessment: Assessment): string {
  return assessment.rationale || "The Guardian gave no specific rationale.";
}

/** Codex-style feedback for a Rejection, as reported to the Guarded Agent. */
export function rejectionReason(assessment: Assessment): string {
  const rationale = statedRationale(assessment);
  return [
    "This action was rejected due to unacceptable risk.",
    `Risk: ${riskLabel(assessment)}. Authorization: ${assessment.authorization}.`,
    `Reason: ${rationale}`,
    "Do not attempt to achieve the same outcome through a workaround, indirect execution, or variations of this call, and do not retry it. Explain the risk to the user and ask whether they want to proceed; continue only with a materially safer alternative or after the user explicitly approves this action.",
  ].join("\n");
}
