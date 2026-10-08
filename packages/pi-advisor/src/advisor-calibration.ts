import { estimateTokens, type AgentSession } from "@earendil-works/pi-coding-agent";
import type { TokenSample } from "@ian-pascoe/pi-utils/token-calibration";

/**
 * Factor assumed for an Advisor model before any of its Reviews reports usage. Review Evidence
 * tokenizes about 1.7–1.9× denser than Pi's chars/4 estimate on Claude models, so this errs
 * toward a smaller seed rather than one that overshoots `seedBudgetTokens`.
 */
export const advisorFallbackTokenFactor = 2;

/** The key a model's calibrated factor is kept under. */
export function calibrationKey(model: { provider: string; id: string } | undefined): string {
  return model ? `${model.provider}/${model.id}` : "unknown";
}

/**
 * What one prompt taught about its model: Pi's chars/4 estimate of the prompt that carried the
 * evidence, and the input tokens it added to the Advisor Session, which is the first response's
 * input less the context before the prompt (the cached system prompt and tools included, as Pi
 * reports it). `contextBefore` is `getContextUsage()?.tokens` before the prompt; with no size
 * known, such as just after compaction, or without reported usage, nothing is learned.
 */
export function promptSample(
  messages: AgentSession["messages"],
  before: number,
  contextBefore: number | null | undefined,
): TokenSample | undefined {
  if (contextBefore === null || contextBefore === undefined) return;
  const added = messages.slice(before);
  const prompt = added.find((message) => message.role === "user");
  const response = added.find((message) => message.role === "assistant");
  if (!prompt || response?.role !== "assistant") return;
  if (response.stopReason === "error" || response.stopReason === "aborted") return;
  const { input, cacheRead, cacheWrite } = response.usage;
  const reported = input + cacheRead + cacheWrite - contextBefore;
  if (!(reported > 0)) return;
  return { estimated: estimateTokens(prompt), reported };
}
