import {
  clampThinkingLevel,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { decide, parseAssessment, type Assessment, type Outcome } from "./guardian-assessment.js";
import type { GuardianThinkingLevel } from "./guardian-settings.js";

/** Token usage of one Guardian Review. */
export interface ReviewUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

/** Measurements recorded for every Guardian Review that reached a model. */
export interface ReviewMetrics {
  /** `provider/id` of the Guardian model, when one resolved. */
  model: string | null;
  durationMs: number;
  usage: ReviewUsage | null;
  /** Cost in dollars; `null` when unknown. */
  cost: number | null;
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
  const name = `${model.provider}/${model.id}`;
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
}

function metrics(
  model: string,
  started: number,
  reply: AssistantMessage | undefined,
): ReviewMetrics {
  const usage = reply?.usage;
  return {
    model,
    durationMs: Date.now() - started,
    usage: usage
      ? {
          input: usage.input,
          output: usage.output,
          cacheRead: usage.cacheRead,
          cacheWrite: usage.cacheWrite,
          total: usage.totalTokens,
        }
      : null,
    cost: usage && Number.isFinite(usage.cost.total) ? usage.cost.total : null,
  };
}

/** Run one Guardian Review: a single completion without tools, bounded by the review timeout. */
export async function runGuardianReview(input: GuardianReviewInput): Promise<ReviewResult> {
  const started = Date.now();
  const name = `${input.model.provider}/${input.model.id}`;
  if (input.signal?.aborted) return { kind: "aborted", ...metrics(name, started, undefined) };
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), input.timeoutMs);
  const signal = input.signal ? AbortSignal.any([input.signal, timeout.signal]) : timeout.signal;
  const level = input.model.reasoning
    ? clampThinkingLevel(input.model, input.thinkingLevel)
    : "off";
  let reply: AssistantMessage | undefined;
  let failure: string | undefined;
  try {
    const stopped = new Promise<undefined>((resolve) => {
      signal.addEventListener("abort", () => resolve(undefined), { once: true });
    });
    const options: ModelsSimpleStreamOptions = { signal, sessionId: input.sessionId };
    if (level !== "off") options.reasoning = level;
    reply = await Promise.race([
      input.registry.streamSimple(input.model, input.context, options).result(),
      stopped,
    ]);
  } catch (cause) {
    failure = cause instanceof Error ? cause.message : String(cause);
  } finally {
    clearTimeout(timer);
  }
  const measured = metrics(name, started, reply);
  if (input.signal?.aborted) return { kind: "aborted", ...measured };
  if (timeout.signal.aborted)
    return {
      kind: "failed",
      failure: `Guardian Review timed out after ${input.timeoutMs / 1_000}s`,
      ...measured,
    };
  if (failure !== undefined || !reply)
    return {
      kind: "failed",
      failure: `Guardian model request failed: ${failure ?? "no response"}`,
      ...measured,
    };
  if (reply.stopReason === "error" || reply.stopReason === "aborted")
    return {
      kind: "failed",
      failure: `Guardian model request failed: ${reply.errorMessage ?? reply.stopReason}`,
      ...measured,
    };
  const text = reply.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");
  try {
    const assessment = parseAssessment(text);
    return {
      kind: "assessed",
      assessment,
      outcome: decide(assessment.risk, assessment.authorization),
      ...measured,
    };
  } catch (cause) {
    return {
      kind: "failed",
      failure: cause instanceof Error ? cause.message : String(cause),
      ...measured,
    };
  }
}
