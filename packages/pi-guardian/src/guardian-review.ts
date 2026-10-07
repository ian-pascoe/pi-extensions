import {
  clampThinkingLevel,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
  decide,
  decidedRisk,
  parseAssessment,
  parseFinalAssessment,
  uncategorized,
  type Assessment,
  type Outcome,
  type RiskCategory,
} from "./guardian-assessment.js";
import type { ReviewUsage } from "./guardian-audit.js";
import { errorMessage } from "./guardian-notify.js";
import type { GuardianThinkingLevel } from "./guardian-settings.js";

/** Measurements recorded for every Guardian Review that reached a model. */
export interface ReviewMetrics {
  /** `provider/id` of the Guardian model, when one resolved. */
  model: string | null;
  durationMs: number;
  usage: ReviewUsage | null;
  /** Cost in dollars; `null` when unknown. */
  cost: number | null;
  /** True when a malformed reply was followed by one corrective retry. */
  retried?: boolean;
  /**
   * Prompt tokens the provider reported for the first attempt (input plus cache reads and
   * writes), to calibrate Guardian's request-size estimate.
   */
  promptTokens?: number;
  /** Guardian's chars/4 estimate of the first request, paired with `promptTokens`. */
  estimatedPromptTokens?: number;
  /** Set when the first pass would have been rejected and an Escalation Pass ran. */
  escalation?: Escalation;
}

/** A review's Escalation Pass: the first pass's assessment and what the second pass produced. */
export interface Escalation {
  firstPass: Assessment;
  pass: ReviewResult;
}

/** What one Guardian Review produced. */
export type ReviewResult =
  | ({ kind: "assessed"; assessment: Assessment; outcome: Outcome } & ReviewMetrics)
  | ({ kind: "failed"; failure: string } & ReviewMetrics)
  | ({ kind: "aborted" } & ReviewMetrics);

/** The model a Guardian Review uses, or why none can be used. */
export type ResolvedGuardianModel =
  | { ok: true; model: Model<Api> }
  | { ok: false; failure: string; model: string | null };

/** A model's `provider/id` name, as the `model` setting and audit entries spell it. */
export function modelName(model: Pick<Model<Api>, "provider" | "id">): string {
  return `${model.provider}/${model.id}`;
}

/** `model` setting (`provider/id`), else the Guarded Agent's current model; it needs auth. */
export function resolveGuardianModel(
  setting: string | undefined,
  registry: Pick<ModelRegistry, "find" | "hasConfiguredAuth">,
  current: Model<Api> | undefined,
): ResolvedGuardianModel {
  let model = current;
  if (setting !== undefined) {
    const slash = setting.indexOf("/");
    model =
      slash > 0 ? registry.find(setting.slice(0, slash), setting.slice(slash + 1)) : undefined;
    if (!model)
      return { ok: false, failure: `Guardian model ${setting} was not found`, model: setting };
  }
  if (!model)
    return {
      ok: false,
      failure: "No Guardian model: set the Guardian model setting or select a session model",
      model: null,
    };
  const name = modelName(model);
  if (!registry.hasConfiguredAuth(model))
    return {
      ok: false,
      failure: `No credentials are configured for Guardian model ${name}`,
      model: name,
    };
  return { ok: true, model };
}

/** Inputs to one stateless Guardian Review. */
export interface GuardianReviewInput {
  registry: Pick<ModelRegistry, "streamSimple">;
  model: Model<Api>;
  thinkingLevel: GuardianThinkingLevel;
  context: Context;
  timeoutMs: number;
  /** The Guarded Agent's turn signal; aborting it aborts the review. */
  signal: AbortSignal | undefined;
  /** Provider cache-affinity key, stable for the Guarded Agent's session. */
  sessionId: string;
  /** The Risk Categories this review may name. */
  categories: readonly RiskCategory[];
  /**
   * The reply reasons before ending with its answer, as an Escalation Pass's does: the last
   * assessment object decides, rather than the only one.
   */
  reasoned?: boolean;
}

/** Token usage summed over a review's attempts; `null` when an attempt reported none. */
function combinedUsage(
  replies: readonly AssistantMessage[],
): Pick<ReviewMetrics, "usage" | "cost"> {
  if (!replies.length) return { usage: null, cost: null };
  const usage: ReviewUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  let cost: number | null = 0;
  for (const { usage: reported } of replies) {
    usage.input += reported.input;
    usage.output += reported.output;
    usage.cacheRead += reported.cacheRead;
    usage.cacheWrite += reported.cacheWrite;
    usage.total += reported.totalTokens;
    cost =
      cost !== null && Number.isFinite(reported.cost.total) ? cost + reported.cost.total : null;
  }
  return { usage, cost };
}

/** Usage and cost of two passes; a pass that reached no model adds nothing. */
function summedUsage(
  first: ReviewMetrics,
  second: ReviewMetrics,
): Pick<ReviewMetrics, "usage" | "cost"> {
  const passes = [first, second].filter((pass) => pass.usage !== null);
  if (!passes.length) return { usage: null, cost: null };
  const usage: ReviewUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  let cost: number | null = 0;
  for (const pass of passes) {
    if (!pass.usage) continue;
    usage.input += pass.usage.input;
    usage.output += pass.usage.output;
    usage.cacheRead += pass.usage.cacheRead;
    usage.cacheWrite += pass.usage.cacheWrite;
    usage.total += pass.usage.total;
    cost = cost !== null && pass.cost !== null ? cost + pass.cost : null;
  }
  return { usage, cost };
}

/**
 * A rejected first pass combined with its Escalation Pass. The second pass's assessment decides
 * when it produced one; when it failed, the first pass's Rejection stands, never an allow. An
 * aborted second pass aborts the review. The first pass's model and calibration sample are kept;
 * duration, usage, and cost are summed.
 */
export function withEscalation(
  first: Extract<ReviewResult, { kind: "assessed" }>,
  pass: ReviewResult,
): ReviewResult {
  const { kind: _kind, assessment, outcome, ...firstMetrics } = first;
  const metrics: ReviewMetrics = {
    ...firstMetrics,
    durationMs: first.durationMs + pass.durationMs,
    ...summedUsage(first, pass),
    escalation: { firstPass: assessment, pass },
  };
  if (pass.kind === "aborted") return { kind: "aborted", ...metrics };
  if (pass.kind === "assessed")
    return { kind: "assessed", assessment: pass.assessment, outcome: pass.outcome, ...metrics };
  return { kind: "assessed", assessment, outcome, ...metrics };
}

/** Follow-up sent once after a malformed reply, restating the output contract. */
export const correctiveMessage =
  'Your reply did not contain exactly one valid assessment. Respond again with exactly one JSON object and nothing else: {"risk_level": "low" | "medium" | "high" | "critical", "user_authorization": "unknown" | "low" | "medium" | "high"}, adding "risk_category" and "rationale" when the output contract asks for them.';

/** Follow-up sent once after a `high` or `critical` assessment without a valid Risk Category. */
export function categoryCorrectiveMessage(categories: readonly RiskCategory[]): string {
  return `Your assessment rated the risk high or critical without naming a valid Risk Category. \`high\` and \`critical\` risk require exactly one of: ${categories.join(", ")}. If one concretely applies to this exact call, respond again with exactly one JSON object naming it in "risk_category", with a "rationale"; if none applies, the risk is \`low\` or \`medium\`, so respond with that assessment instead. Respond with the JSON object and nothing else.`;
}

/** Text of a reply's text blocks. */
function replyText(reply: AssistantMessage): string {
  return reply.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}

/**
 * Run one Guardian Review: a completion without tools, bounded by the review timeout. A reply
 * without a valid assessment gets one corrective follow-up within the same deadline; the first
 * request is unchanged, so its prefix stays cacheable. Pi's provider-neutral API offers no JSON
 * mode or forced tool call, so the contract is enforced by parsing.
 */
export async function runGuardianReview(input: GuardianReviewInput): Promise<ReviewResult> {
  const started = Date.now();
  const name = modelName(input.model);
  const replies: AssistantMessage[] = [];
  const measured = (): ReviewMetrics => {
    const result: ReviewMetrics = {
      model: name,
      durationMs: Date.now() - started,
      ...combinedUsage(replies),
    };
    const first = replies[0]?.usage;
    if (first) result.promptTokens = first.input + first.cacheRead + first.cacheWrite;
    if (replies.length > 1) result.retried = true;
    return result;
  };
  if (input.signal?.aborted) return { kind: "aborted", ...measured() };
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), input.timeoutMs);
  const signal = input.signal ? AbortSignal.any([input.signal, timeout.signal]) : timeout.signal;
  const stopped = new Promise<undefined>((resolve) => {
    signal.addEventListener("abort", () => resolve(undefined), { once: true });
  });
  const level = input.model.reasoning
    ? clampThinkingLevel(input.model, input.thinkingLevel)
    : "off";
  const options: ModelsSimpleStreamOptions = { signal, sessionId: input.sessionId };
  if (level !== "off") options.reasoning = level;
  let context = input.context;
  const assessed = (assessment: Assessment): ReviewResult => ({
    kind: "assessed",
    assessment,
    outcome: decide(decidedRisk(assessment), assessment.authorization),
    ...measured(),
  });
  try {
    for (;;) {
      let reply: AssistantMessage | undefined;
      let failure: string | undefined;
      try {
        reply = await Promise.race([
          input.registry.streamSimple(input.model, context, options).result(),
          stopped,
        ]);
      } catch (cause) {
        failure = errorMessage(cause);
      }
      if (reply) replies.push(reply);
      if (input.signal?.aborted) return { kind: "aborted", ...measured() };
      if (timeout.signal.aborted)
        return {
          kind: "failed",
          failure: `Guardian Review timed out after ${input.timeoutMs / 1_000}s`,
          ...measured(),
        };
      if (failure !== undefined || !reply)
        return {
          kind: "failed",
          failure: `Guardian model request failed: ${failure ?? "no response"}`,
          ...measured(),
        };
      if (reply.stopReason === "error" || reply.stopReason === "aborted")
        return {
          kind: "failed",
          failure: `Guardian model request failed: ${reply.errorMessage ?? reply.stopReason}`,
          ...measured(),
        };
      let corrective = correctiveMessage;
      try {
        const parse = input.reasoned ? parseFinalAssessment : parseAssessment;
        const assessment = parse(replyText(reply), input.categories);
        // Ask once for a missing or unknown Risk Category; only a retry that still lacks one is
        // decided as `medium`. A malformed retry is a failure, never the first reply decided as
        // `medium`: that would turn a `critical` into an allow.
        if (!uncategorized(assessment) || replies.length > 1) return assessed(assessment);
        corrective = categoryCorrectiveMessage(input.categories);
      } catch (cause) {
        if (replies.length > 1)
          return {
            kind: "failed",
            failure: `${errorMessage(cause)}, even after a corrective retry`,
            ...measured(),
          };
      }
      context = {
        ...input.context,
        messages: [
          ...input.context.messages,
          reply,
          { role: "user", content: corrective, timestamp: 0 },
        ],
      };
    }
  } finally {
    clearTimeout(timer);
  }
}
