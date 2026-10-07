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

/** The Guardian's required answer; extra fields are tolerated and ignored. */
export const assessmentSchema = Type.Object({
  risk_level: riskLevelSchema,
  user_authorization: userAuthorizationSchema,
  rationale: Type.String(),
});
/** One Guardian Review's assessment. */
export interface Assessment {
  risk: RiskLevel;
  authorization: UserAuthorization;
  rationale: string;
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
function assessments(text: string): Assessment[] {
  const found: Assessment[] = [];
  for (const candidate of [text.trim(), ...objectSpans(text)]) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!Value.Check(assessmentSchema, parsed)) continue;
    found.push({
      risk: parsed.risk_level,
      authorization: parsed.user_authorization,
      rationale: parsed.rationale.trim(),
    });
  }
  return found;
}

/**
 * Parse a Guardian reply; throws a Review Failure message unless it holds exactly one valid
 * assessment. Repeating the same assessment is tolerated; differing assessments are ambiguous.
 */
export function parseAssessment(text: string): Assessment {
  const [first, ...rest] = assessments(text);
  if (!first)
    throw new Error("Guardian returned malformed output (expected the assessment JSON object)");
  if (rest.some((other) => !isDeepStrictEqual(other, first)))
    throw new Error(
      "Guardian returned malformed output (more than one differing assessment JSON object)",
    );
  return first;
}

/** Codex-style feedback for a Rejection, as reported to the Guarded Agent. */
export function rejectionReason(assessment: Assessment): string {
  const rationale = assessment.rationale || "The Guardian gave no specific rationale.";
  return [
    "This action was rejected due to unacceptable risk.",
    `Risk: ${assessment.risk}. Authorization: ${assessment.authorization}.`,
    `Reason: ${rationale}`,
    "Do not attempt to achieve the same outcome through a workaround, indirect execution, or variations of this call, and do not retry it. Explain the risk to the user and ask whether they want to proceed; continue only with a materially safer alternative or after the user explicitly approves this action.",
  ].join("\n");
}
