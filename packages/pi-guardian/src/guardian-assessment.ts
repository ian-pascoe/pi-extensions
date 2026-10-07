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

/** JSON candidates in a reply: the whole text, fenced blocks, then the outermost braces. */
function candidates(text: string): string[] {
  const found = [text.trim()];
  for (const match of text.matchAll(/```(?:json)?\s*\n?([\s\S]*?)```/gi))
    if (match[1]) found.push(match[1].trim());
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) found.push(text.slice(start, end + 1));
  return found;
}

/** Parse a Guardian reply; throws a Review Failure message when no valid assessment is found. */
export function parseAssessment(text: string): Assessment {
  for (const candidate of candidates(text)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!Value.Check(assessmentSchema, parsed)) continue;
    return {
      risk: parsed.risk_level,
      authorization: parsed.user_authorization,
      rationale: parsed.rationale.trim(),
    };
  }
  throw new Error("Guardian returned malformed output (expected the assessment JSON object)");
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
