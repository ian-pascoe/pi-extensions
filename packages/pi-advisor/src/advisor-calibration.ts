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

/** Pi's chars/4 estimate of the system prompt and active tool definitions a provider receives. */
function setupEstimate(session: AgentSession): number {
  const active = new Set(session.getActiveToolNames());
  const tools = session
    .getAllTools()
    .filter(({ name }) => active.has(name))
    .map(({ name, description, parameters }) => ({ name, description, parameters }));
  return Math.ceil(JSON.stringify([session.systemPrompt, tools]).length / 4);
}

/**
 * The Advisor Session's size in tokens before a prompt, as the provider counts it, or null when
 * Pi reports none (such as just after compaction). Pi's `getContextUsage()` counts the system
 * prompt and tool definitions only through the last response's reported usage; a session that has
 * not yet recorded its system message, and so has no usage, reports just its messages, so their
 * Pi estimate is added. `totalTokens` includes the previous response's output tokens, which the
 * next request resends as input, so that is the right baseline.
 */
export function contextBeforePrompt(session: AgentSession): number | null {
  const tokens = session.getContextUsage()?.tokens;
  if (tokens === null || tokens === undefined) return null;
  const hasSystem = session.messages.some((message) => message.role === "system");
  return hasSystem ? tokens : tokens + setupEstimate(session);
}

/**
 * What one prompt taught about its model: Pi's chars/4 estimate of the prompt that carried the
 * evidence, and the input tokens it added to the Advisor Session, which is the first response's
 * input less `contextBefore` (see `contextBeforePrompt`, which includes the cached system prompt
 * and tools). With no size known, a response without usage, or an error, nothing is learned.
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
