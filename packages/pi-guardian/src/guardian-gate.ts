import { isDeepStrictEqual } from "node:util";
import { validateToolArguments, type ToolCall } from "@earendil-works/pi-ai";
import {
  getAgentDir,
  type AgentSession,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionEntry,
  type ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  rejectionReason,
  riskLabel,
  statedRationale,
  uncategorized,
  validRiskCategories,
  type RiskCategory,
} from "./guardian-assessment.js";
import {
  auditArguments,
  calibrationSamples,
  recordedDelegations,
  recordedOverrides,
  reviewEntryType,
  type AuditResult,
  type EscalationTrigger,
  type EscalationRecord,
  type ReviewEntry,
} from "./guardian-audit.js";
import { tokenFactor } from "./guardian-calibration.js";
import {
  classifierFailure,
  classifierQuestions,
  classifierState,
  classifierTrigger,
  resolveClassifierModel,
  runClassifierPass,
} from "./guardian-classifier.js";
import { overrideDialogs } from "./guardian-dialog.js";
import {
  branchMessages,
  delegatedText,
  renderReviewedCall,
  selectEvidence,
  textSha256,
  textTokens,
  typedUserMessages,
  userMessageKey,
  userText,
  isCoordinationFrom,
  type ApprovedDelegation,
  type BatchCall,
  type Delegator,
  type CallUnderReview,
  type IssuingCall,
  type RootUserMessage,
  type ToolInput,
} from "./guardian-evidence.js";
import { errorMessage, notify } from "./guardian-notify.js";
import { contextFiles, loadedResourcePaths } from "./guardian-pi-resources.js";
import { escalationInstruction, guardianSystemPrompt } from "./guardian-prompt.js";
import {
  modelName,
  resolveGuardianModel,
  runGuardianReview,
  withEscalation,
  type ReviewResult,
} from "./guardian-review.js";
import type { GuardedSessionRole } from "./guardian-root-registry.js";
import {
  configuredClassifier,
  contextWindowOrFallback,
  escalationThinkingLevel,
  evidenceBudget,
  type GuardianConfig,
} from "./guardian-settings.js";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { processShellEnvironment, type ShellEnvironment } from "./safe-command.js";
import type { SensitivePathContext } from "./sensitive-paths.js";
import {
  onlyReads,
  readOnlyBuiltIns,
  resolveToolPolicy,
  type ResolvedToolPolicy,
} from "./tool-policy.js";
import { TROUBLESHOOTING_HINT } from "./troubleshooting-skill.js";

/** What the review gate reads from the extension that owns the session. */
export interface ReviewGateHost {
  session(): AgentSession | undefined;
  /** Why the session is unavailable, when it is. */
  unavailable(): string;
  role(): GuardedSessionRole;
  /** The root user's typed messages, for a Child Agent's or Advisor's evidence. */
  rootUserMessages(): RootUserMessage[];
  /** A Child Agent's delegating agent and the delegations its Guardian or user allowed. */
  delegator(): Delegator | undefined;
  /** Settings to enforce, or the error that makes every non-read-only call fail closed. */
  settings(): { config: GuardianConfig; error: string | undefined };
  /** The set of tools under review changed. */
  reviewingChanged(): void;
}

/** The running review gate. */
export interface ReviewGate {
  /** Tool names currently under review. */
  reviewing(): string[];
  /** Forget a replaced session's calls and reviews without recording them. */
  reset(): void;
  /** Record held and unconsumed reviews before the session ends. */
  flush(): void;
  /** The messages this session's user typed, for its Child Agents and Advisors. */
  typedUserMessages(): RootUserMessage[];
  /** The delegations this session's Guardian or user allowed, for its Child Agents. */
  approvedDelegations(): ApprovedDelegation[];
}

/** One call as seen by Guardian's `tool_call` handler. */
interface SeenCall {
  toolCallId: string;
  toolName: string;
  /** The arguments as reviewed: a snapshot taken before the review started. */
  input: ToolInput;
  parentToolCallId: string | undefined;
}

/** A Guardian Review started when the assistant message ended, ahead of its call's preflight. */
interface Prefetch {
  /** The reviewed snapshot of the call, as validated for its tool. */
  call: SeenCall;
  /** What the review depended on besides the call; it is used only if this is unchanged. */
  basis: string;
  controller: AbortController;
  result: Promise<ReviewResult>;
  consumed: boolean;
}

/** An allowed call's audit entry, held until its result shows it ran and whether it drifted. */
interface PendingAudit {
  entry: ReviewEntry;
  /** The arguments the review judged. */
  reviewedInput: ToolInput;
}

/** A user message an extension sent, awaiting the message Pi builds from it. */
interface ExtensionInput {
  text: string;
  /** Pi appends image-processing hints to the text of a message with images. */
  images: boolean;
  /** The agent run current when it arrived; see {@link installReviewGate}'s `agent_end`. */
  run: number;
}

/** Early reviews running at once; the rest wait for a slot. */
const maxConcurrentPrefetches = 4;
/** Tokens kept free for the Guardian's reasoning and reply. */
const outputReserveTokens = 8_192;
/** Remembered extension-sent inputs awaiting their user message. */
const maxPendingInputs = 32;

/** Custom entry marking a user message that an extension sent, so it is untrusted evidence. */
export const extensionMessageEntryType = "pi-guardian-extension-message";
const extensionMessageSchema = Type.Object({ version: Type.Literal(1), key: Type.String() });

/** Keys of user messages extensions sent on this branch. */
function extensionMessages(branch: readonly SessionEntry[]): Set<string> {
  return new Set(
    branch.flatMap((entry) =>
      entry.type === "custom" &&
      entry.customType === extensionMessageEntryType &&
      Value.Check(extensionMessageSchema, entry.data)
        ? [entry.data.key]
        : [],
    ),
  );
}

/** Minimal Subagents' `subagent` and `agent_message` result details name the agent reached. */
const delegationResultSchema = Type.Object({ agent_id: Type.String({ minLength: 1 }) });

/** Whether a user message's text is exactly what an extension sent, plus Pi's image hints. */
function sentBy(input: ExtensionInput, text: string): boolean {
  return text === input.text || (input.images && text.startsWith(`${input.text}\n\n`));
}

/** Run at most `max` tasks at once, in arrival order. */
function limiter(max: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async (task) => {
    if (active < max) active++;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await task();
    } finally {
      // Hand the slot straight to the next waiter so no newcomer can overtake it.
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

/** What one review sees, before its evidence is sized to a model. */
interface ReviewInputs {
  /** The rendered Reviewed Call, never shortened. */
  reviewed: string;
  categories: readonly RiskCategory[];
  /** Provider cache-affinity key, stable for the Guarded Agent's session. */
  sessionId: string;
  /** Evidence blocks within a budget, in Pi's chars/4 tokens. */
  evidence(budgetTokens: number, capBudgetTokens: number): string[];
}

/** A language model's review request and Guardian's chars/4 estimate of its size. */
interface ModelRequest {
  systemPrompt: string;
  blocks: string[];
  estimated: number;
}

function failed(failure: string): ReviewResult {
  return { kind: "failed", failure, model: null, durationMs: 0, usage: null, cost: null };
}

/**
 * The Risk Categories a review offers: `security_policy` only when the user configured a
 * Security Policy or a `deny` Command Rule for a call to violate.
 */
function reviewCategories(config: GuardianConfig): readonly RiskCategory[] {
  return validRiskCategories(
    config.policy.trim() !== "" || Object.values(config.commands).includes("deny"),
  );
}

/** One user message holding a review's text blocks; its fixed timestamp keeps prefixes stable. */
function reviewRequest(systemPrompt: string, blocks: readonly string[]): Context {
  return {
    systemPrompt,
    messages: [
      {
        role: "user",
        content: blocks.map((text) => ({ type: "text", text })),
        timestamp: 0,
      },
    ],
  };
}

function agentLabel(role: GuardedSessionRole): string {
  if (role.kind === "main") return "the main Pi agent";
  if (role.kind === "child")
    return "a Minimal Subagents Child Agent (its task comes from another agent, not the user)";
  return "an Advisor (its requests come from Pi, not the user)";
}

const streakEndedReason =
  "Guardian ended the agent's turn after too many consecutive blocked calls; this call did not run. Stop, explain what was blocked, and ask the user how to proceed.";

/** Gate tool calls with Guardian Reviews: early reviews, Tool Policies, Outcomes, and audits. */
export function installReviewGate(pi: ExtensionAPI, host: ReviewGateHost): ReviewGate {
  let streak = 0;
  /**
   * The Rejection Streak reached its limit. Pi ends a turn only when every call of a tool batch
   * asks it to, so until the next prompt every call is blocked and asks to end it: a batch
   * call that already ran keeps the turn for one more response, whose calls all end it.
   */
  let ending = false;
  /** Tool names under review, keyed per review so a superseded review cannot clear another. */
  const reviewing = new Map<symbol, string>();
  const calls = new Map<string, SeenCall>();
  const prefetched = new Map<string, Prefetch>();
  const pendingAudits = new Map<string, PendingAudit>();
  const extensionInputs: ExtensionInput[] = [];
  /** Agent runs started, to age out extension inputs that never became messages. */
  let runs = 0;
  const askOverride = overrideDialogs();
  const prefetchSlot = limiter(maxConcurrentPrefetches);

  function append(entry: ReviewEntry): void {
    try {
      pi.appendEntry(reviewEntryType, entry);
    } catch {
      // The session ended while a review settled; nothing remains to record it in.
    }
  }

  function pathContext(ctx: ExtensionContext): SensitivePathContext {
    const session = host.session();
    return {
      cwd: ctx.cwd,
      piDirectories: [getAgentDir(), ctx.sessionManager.getSessionDir()].filter(Boolean),
      loadedResources: session ? loadedResourcePaths(session.resourceLoader, ctx.cwd) : [],
    };
  }

  /** The other tool calls of the assistant message that issued `toolCallId`. */
  function batchOf(toolCallId: string): ToolCall[] {
    for (const message of host.session()?.messages.toReversed() ?? []) {
      if (message.role !== "assistant") continue;
      const blocks = message.content.flatMap((part) => (part.type === "toolCall" ? [part] : []));
      if (blocks.some((block) => block.id === toolCallId)) return blocks;
    }
    return [];
  }

  /** Whether Pi runs a batch one call at a time: by setting, or because one of its tools asks. */
  function sequentialBatch(blocks: readonly ToolCall[]): boolean {
    const agent = host.session()?.agent;
    if (!agent) return true;
    if (agent.toolExecution === "sequential") return true;
    return blocks.some(
      (block) =>
        agent.state.tools.find((tool) => tool.name === block.name)?.executionMode === "sequential",
    );
  }

  /**
   * Whether no other call can change the file system before `call` runs. Pi prepares a parallel
   * batch's calls one by one and then runs them together, so only other calls that only read
   * keep it settled; a sequential batch prepares each call after the earlier ones ran. A script's
   * nested calls may run concurrently with calls this extension never sees.
   */
  function settledFor(call: SeenCall, batch: readonly ToolCall[]): boolean {
    if (call.parentToolCallId !== undefined) return false;
    if (!batch.some((block) => block.id === call.toolCallId)) return false;
    if (sequentialBatch(batch)) return true;
    return batch.every(
      (block) =>
        block.id === call.toolCallId || onlyReads(block.name, block.arguments, shellEnvironment()),
    );
  }

  /** The call's Tool Policy, judged against the file system as it is now. */
  function policyFor(
    ctx: ExtensionContext,
    config: GuardianConfig,
    call: SeenCall,
    batch: readonly ToolCall[],
  ): ResolvedToolPolicy {
    return resolveToolPolicy({
      settled: settledFor(call, batch),
      toolName: call.toolName,
      input: call.input,
      configured: config.tools,
      commands: config.commands,
      annotations: pi.getAllTools().find((tool) => tool.name === call.toolName)?.annotations,
      paths: pathContext(ctx),
      environment: shellEnvironment(),
    });
  }

  /** What the session's `bash` commands inherit: this process's environment and Pi's settings. */
  function shellEnvironment(): ShellEnvironment {
    const settings = host.session()?.settingsManager;
    return {
      ...processShellEnvironment(),
      shellPath: settings?.getShellPath(),
      commandPrefix: settings?.getShellCommandPrefix(),
    };
  }

  /**
   * The other calls of a call's tool batch, as context for its review: for a nested call, those
   * of its issuing call's batch, which Pi may run alongside the issuing script. The issuing call
   * is shown on its own, and the script's other nested calls only within its arguments.
   */
  function batchSiblings(call: SeenCall, batch: readonly ToolCall[]): BatchCall[] {
    const own = call.parentToolCallId ?? call.toolCallId;
    return batch.flatMap((other) =>
      other.id === own ? [] : [{ toolName: other.name, input: other.arguments }],
    );
  }

  /**
   * What a review depends on besides the call: its Tool Policy and reason (which names any
   * Sensitive Path and where it resolves), the settings, and the Guardian model. A review started
   * early is used only if all are unchanged when its call arrives; a call before it may have
   * changed the file system, as in a sequential batch.
   */
  function reviewBasis(
    ctx: ExtensionContext,
    config: GuardianConfig,
    policy: ResolvedToolPolicy,
  ): string {
    const model = config.model ?? (ctx.model ? modelName(ctx.model) : null);
    return JSON.stringify({ policy, config, model });
  }

  /** The issuing call of a nested call, from calls seen this run or the transcript. */
  function issuingCall(parentToolCallId: string | undefined): IssuingCall | undefined {
    if (parentToolCallId === undefined) return undefined;
    const seen = calls.get(parentToolCallId);
    if (seen) return { toolName: seen.toolName, input: seen.input };
    const block = batchOf(parentToolCallId).find((part) => part.id === parentToolCallId);
    if (block) return { toolName: block.name, input: block.arguments };
    return { toolName: "unknown", input: { toolCallId: parentToolCallId } };
  }

  function underReview(call: SeenCall): CallUnderReview {
    return {
      toolName: call.toolName,
      input: call.input,
      parent: issuingCall(call.parentToolCallId),
    };
  }

  /** Run one Guardian Review of `call` against the current evidence. */
  async function review(
    ctx: ExtensionContext,
    config: GuardianConfig,
    call: SeenCall,
    reason: string | undefined,
    batch: readonly ToolCall[],
    signal: AbortSignal | undefined,
  ): Promise<ReviewResult> {
    const session = host.session();
    if (!session) return failed(host.unavailable());
    const role = host.role();
    const branch = ctx.sessionManager.getBranch();
    const inputs: ReviewInputs = {
      reviewed: renderReviewedCall({
        ...underReview(call),
        cwd: ctx.cwd,
        agent: agentLabel(role),
        reason,
        batch: batchSiblings(call, batch),
      }),
      categories: reviewCategories(config),
      sessionId: `pi-guardian:${ctx.sessionManager.getSessionId()}`,
      evidence: (budgetTokens, capBudgetTokens) =>
        selectEvidence({
          sources: branchMessages(branch),
          trustUserMessages: role.kind === "main",
          contextFiles: contextFiles(session, getAgentDir()),
          extensionMessages: extensionMessages(branch),
          overrides: recordedOverrides(branch),
          rootUserMessages: host.rootUserMessages(),
          delegator: host.delegator(),
          currentCalls: new Set(
            call.parentToolCallId === undefined
              ? [call.toolCallId]
              : [call.toolCallId, call.parentToolCallId],
          ),
          budgetTokens,
          capBudgetTokens,
        }).blocks,
    };
    const key = Symbol(call.toolCallId);
    reviewing.set(key, call.toolName);
    host.reviewingChanged();
    try {
      const classifier = configuredClassifier(config);
      if (classifier !== undefined) {
        const first = await classifierPass(ctx, config, classifier, inputs, signal);
        const trigger = classifierTrigger(first, config.escalationThreshold);
        if (!trigger) return first;
        return withEscalation(first, trigger, await escalate(ctx, config, inputs, trigger, signal));
      }
      const resolved = resolveGuardianModel(config.model, ctx.modelRegistry, ctx.model);
      if (!resolved.ok) return { ...failed(resolved.failure), model: resolved.model };
      const request = modelRequest(ctx, config, resolved.model, inputs, 0);
      if ("failure" in request) return { ...failed(request.failure), model: request.model };
      const first = await runGuardianReview({
        registry: ctx.modelRegistry,
        model: resolved.model,
        thinkingLevel: config.thinkingLevel,
        context: reviewRequest(request.systemPrompt, request.blocks),
        timeoutMs: config.reviewTimeoutMs,
        signal,
        sessionId: inputs.sessionId,
        categories: inputs.categories,
      });
      const measured =
        first.promptTokens === undefined
          ? first
          : { ...first, estimatedPromptTokens: request.estimated };
      if (measured.kind !== "assessed" || measured.outcome === "allowed") return measured;
      return withEscalation(
        measured,
        "rejected",
        await escalate(ctx, config, inputs, "rejected", signal, request),
      );
    } finally {
      reviewing.delete(key);
      host.reviewingChanged();
    }
  }

  /**
   * A language model's review request: system prompt, evidence sized to the model, and the
   * Reviewed Call, which is never shortened and so must fit beside the policy, `reserved` tokens
   * of further blocks, and the reply.
   */
  function modelRequest(
    ctx: ExtensionContext,
    config: GuardianConfig,
    model: Model<Api>,
    inputs: ReviewInputs,
    reserved: number,
  ): ModelRequest | { failure: string; model: string } {
    const systemPrompt = guardianSystemPrompt(config.policy, config.verbose, inputs.categories);
    const name = modelName(model);
    // Pi's chars/4 estimate, scaled by this model's factor as calibrated on the branch.
    const factor = tokenFactor(calibrationSamples(ctx.sessionManager.getBranch(), name));
    const tokens = (text: string) => Math.ceil(textTokens(text) * factor);
    const capacity =
      contextWindowOrFallback(model.contextWindow) -
      tokens(systemPrompt) -
      outputReserveTokens -
      Math.ceil(reserved * factor);
    const callTokens = tokens(inputs.reviewed);
    if (callTokens > capacity)
      return {
        failure: `the call is too large for Guardian model ${name} to review in full (about ${callTokens} tokens; at most ${Math.max(0, capacity)} fit), and Guardian never reviews a shortened call`,
        model: name,
      };
    const budget = evidenceBudget(config.evidenceBudgetTokens, model.contextWindow);
    // Selection counts chars/4, so the budget in real tokens is scaled down by the factor.
    const evidence = inputs.evidence(
      Math.floor(Math.min(budget, capacity - callTokens) / factor),
      Math.floor(budget / factor),
    );
    const blocks = [...evidence, inputs.reviewed];
    const estimated = textTokens(systemPrompt) + blocks.reduce((sum, b) => sum + textTokens(b), 0);
    return { systemPrompt, blocks, estimated };
  }

  /**
   * A classifier's First Pass: the Security Policy, evidence sized to the classifier, and the
   * Reviewed Call as its state, judged by three `choice` questions. A classifier that cannot be
   * used, or a call too large for it, fails the First Pass, which then escalates.
   */
  async function classifierPass(
    ctx: ExtensionContext,
    config: GuardianConfig,
    setting: string,
    inputs: ReviewInputs,
    signal: AbortSignal | undefined,
  ): Promise<ReviewResult> {
    const unusable = (failure: string, model: string) =>
      classifierFailure(failure, config.escalationThreshold, {
        model,
        durationMs: 0,
        usage: null,
        cost: null,
      });
    const resolved = resolveClassifierModel(setting, ctx.modelRegistry);
    if (!resolved.ok) return unusable(resolved.failure, setting);
    const name = modelName(resolved.model);
    const questions = classifierQuestions(inputs.categories);
    const factor = tokenFactor(calibrationSamples(ctx.sessionManager.getBranch(), name));
    const tokens = (text: string) => Math.ceil(textTokens(text) * factor);
    const capacity =
      contextWindowOrFallback(resolved.model.contextWindow) -
      tokens(JSON.stringify(questions)) -
      tokens(JSON.stringify(classifierState(config.policy, [], "")));
    const callTokens = tokens(JSON.stringify(inputs.reviewed));
    if (callTokens > capacity)
      return unusable(
        `the call is too large for Guardian classifier ${name} (about ${callTokens} tokens; at most ${Math.max(0, capacity)} fit)`,
        name,
      );
    const budget = evidenceBudget(config.evidenceBudgetTokens, resolved.model.contextWindow);
    const evidence = inputs.evidence(
      Math.floor(Math.min(budget, capacity - callTokens) / factor),
      Math.floor(budget / factor),
    );
    const state = classifierState(config.policy, evidence, inputs.reviewed);
    const first = await runClassifierPass({
      registry: ctx.modelRegistry,
      model: resolved.model,
      context: { state, questions: { ...questions } },
      categories: inputs.categories,
      threshold: config.escalationThreshold,
      signal,
    });
    if (first.promptTokens === undefined) return first;
    const estimated = textTokens(JSON.stringify(state)) + textTokens(JSON.stringify(questions));
    return { ...first, estimatedPromptTokens: estimated };
  }

  /**
   * The Escalation Pass of a review whose First Pass escalated: a language model's request plus a
   * final instruction asking for careful reasoning, with the escalation model and thinking level
   * and its own deadline. After a language model's First Pass, its request extends that pass's,
   * so the cached system prompt is reused; the cached messages are reused only with the same
   * model and thinking settings, since a provider such as Anthropic invalidates cached messages
   * when thinking changes. After a classifier's, the request is built for the escalation model.
   */
  async function escalate(
    ctx: ExtensionContext,
    config: GuardianConfig,
    inputs: ReviewInputs,
    trigger: EscalationTrigger,
    signal: AbortSignal | undefined,
    firstRequest?: ModelRequest,
  ): Promise<ReviewResult> {
    const resolved = resolveGuardianModel(
      config.escalationModel ?? config.model,
      ctx.modelRegistry,
      ctx.model,
    );
    if (!resolved.ok) return { ...failed(resolved.failure), model: resolved.model };
    const name = modelName(resolved.model);
    const instruction = escalationInstruction(inputs.categories, trigger);
    const request =
      firstRequest ?? modelRequest(ctx, config, resolved.model, inputs, textTokens(instruction));
    if ("failure" in request) return { ...failed(request.failure), model: name };
    const blocks = [...request.blocks, instruction];
    const factor = tokenFactor(calibrationSamples(ctx.sessionManager.getBranch(), name));
    const size = Math.ceil(
      (textTokens(request.systemPrompt) + blocks.reduce((sum, b) => sum + textTokens(b), 0)) *
        factor,
    );
    const capacity = contextWindowOrFallback(resolved.model.contextWindow) - outputReserveTokens;
    if (size > capacity)
      return {
        ...failed(
          `the review is too large for escalation model ${name} (about ${size} tokens; at most ${Math.max(0, capacity)} fit)`,
        ),
        model: name,
      };
    return runGuardianReview({
      registry: ctx.modelRegistry,
      model: resolved.model,
      thinkingLevel: escalationThinkingLevel(config),
      context: reviewRequest(request.systemPrompt, blocks),
      timeoutMs: config.reviewTimeoutMs,
      signal,
      sessionId: inputs.sessionId,
      categories: inputs.categories,
      reasoned: true,
    });
  }

  /** The audit record of a review's Escalation Pass. */
  function escalationRecord(review: ReviewResult): EscalationRecord | undefined {
    if (!review.escalation) return undefined;
    const { trigger, firstPass, pass } = review.escalation;
    const record: EscalationRecord = {
      trigger,
      firstPass: firstPass
        ? {
            risk: firstPass.risk,
            authorization: firstPass.authorization,
            rationale: firstPass.rationale || null,
          }
        : null,
      result: pass.kind,
      failure: pass.kind === "failed" ? pass.failure : null,
      model: pass.model,
      durationMs: pass.durationMs,
      usage: pass.usage,
      cost: pass.cost,
    };
    if (record.firstPass && firstPass?.category) record.firstPass.riskCategory = firstPass.category;
    if (pass.retried) record.retried = true;
    return record;
  }

  function auditEntry(call: SeenCall, review: ReviewResult, result: AuditResult): ReviewEntry {
    const entry: ReviewEntry = {
      version: 1,
      toolName: call.toolName,
      toolCallId: call.toolCallId,
      parentToolCallId: call.parentToolCallId ?? null,
      ...auditArguments(call.input),
      risk: review.kind === "assessed" ? review.assessment.risk : null,
      authorization: review.kind === "assessed" ? review.assessment.authorization : null,
      result,
      rationale: review.kind === "assessed" ? review.assessment.rationale : null,
      failure: review.kind === "failed" ? review.failure : null,
      userOverride: false,
      blocked: result !== "allowed",
      model: review.model,
      durationMs: review.durationMs,
      usage: review.usage,
      cost: review.cost,
    };
    if (review.estimatedPromptTokens !== undefined && review.promptTokens !== undefined) {
      entry.estimatedPromptTokens = review.estimatedPromptTokens;
      entry.promptTokens = review.promptTokens;
    }
    if (review.kind === "assessed") {
      if (review.assessment.category) entry.riskCategory = review.assessment.category;
      if (uncategorized(review.assessment)) entry.downgraded = true;
    }
    if (review.retried) entry.retried = true;
    const escalation = escalationRecord(review);
    if (escalation) entry.escalation = escalation;
    if (review.classification) entry.classification = review.classification;
    const delegated = delegatedText(call.toolName, call.input);
    if (delegated !== undefined) entry.delegationSha256 = textSha256(delegated);
    return entry;
  }

  /** Hold an allowed call's entry until its result shows that it ran. */
  function allow(call: SeenCall, entry: ReviewEntry): undefined {
    pendingAudits.set(call.toolCallId, { entry, reviewedInput: call.input });
    return undefined;
  }

  function blocked(
    config: GuardianConfig,
    entry: ReviewEntry,
    reason: string,
  ): ToolCallEventResult {
    append(entry);
    streak++;
    const result: ToolCallEventResult = { block: true, reason };
    if (config.maxConsecutiveRejections > 0 && streak >= config.maxConsecutiveRejections) {
      ending = true;
      result.terminate = true;
    }
    return result;
  }

  /** Turn a review into the call's fate: allow, ask the user, or block. */
  async function settle(
    ctx: ExtensionContext,
    config: GuardianConfig,
    call: SeenCall,
    review: ReviewResult,
  ): Promise<ToolCallEventResult | undefined> {
    if (review.kind === "aborted") {
      append(auditEntry(call, review, "aborted"));
      return { block: true, reason: "Guardian Review was aborted; the call did not run." };
    }
    if (review.kind === "assessed" && review.outcome === "allowed")
      return allow(call, auditEntry(call, review, "allowed"));
    const request = underReview(call);
    if (review.kind === "assessed") {
      const { authorization } = review.assessment;
      const risk = riskLabel(review.assessment);
      const rationale = statedRationale(review.assessment);
      notify(ctx, `rejected ${call.toolName} (${risk} risk): ${rationale}`, "warning");
      const entry = auditEntry(call, review, "rejected");
      if (
        config.onDeny === "ask" &&
        (await askOverride(ctx, {
          ...request,
          headline: `Guardian rejected ${call.toolName} — risk ${risk}, authorization ${authorization}\n${rationale}`,
        }))
      )
        return allow(call, { ...entry, userOverride: true, blocked: false });
      return blocked(config, entry, rejectionReason(review.assessment));
    }
    notify(ctx, `could not review ${call.toolName}: ${review.failure}`, "warning");
    const entry = auditEntry(call, review, "failed");
    if (
      await askOverride(ctx, {
        ...request,
        headline: `Guardian could not review ${call.toolName}: ${review.failure}`,
      })
    )
      return allow(call, { ...entry, userOverride: true, blocked: false });
    return blocked(
      config,
      entry,
      `Guardian could not review this ${call.toolName} call, so it was blocked: ${review.failure}. Do not retry it or work around it; tell the user that Guardian could not review the action and ask how to proceed.\n\n${TROUBLESHOOTING_HINT}`,
    );
  }

  /** Record an unconsumed early review once it settles. */
  function discard(prefetch: Prefetch): void {
    if (prefetch.consumed) return;
    prefetch.consumed = true;
    prefetch.controller.abort();
    void prefetch.result.then((result) => {
      if (result.usage || result.durationMs > 0)
        append(auditEntry(prefetch.call, result, "unused"));
    });
  }

  /** Start early reviews for a response's calls, so parallel calls are reviewed concurrently. */
  function prefetch(ctx: ExtensionContext, blocks: readonly ToolCall[]): void {
    const { config, error } = host.settings();
    if (!config.enabled || error || ending) return;
    const tools = pi.getAllTools();
    // In a sequential batch each call's preflight follows the earlier calls' results, which an
    // early review could not see, so only the first call is reviewed early.
    const candidates = sequentialBatch(blocks) ? blocks.slice(0, 1) : blocks;
    for (const block of candidates) {
      if (prefetched.has(block.id)) continue;
      const tool = tools.find((candidate) => candidate.name === block.name);
      // Pi never runs calls to unknown tools or with invalid arguments; review those on arrival.
      if (!tool) continue;
      let input: ToolInput;
      try {
        input = validateToolArguments(tool, block);
      } catch {
        continue;
      }
      const call: SeenCall = {
        toolCallId: block.id,
        toolName: block.name,
        input: structuredClone(input),
        parentToolCallId: undefined,
      };
      const policy = policyFor(ctx, config, call, blocks);
      if (policy.policy !== "review") continue;
      const controller = new AbortController();
      const signal = ctx.signal
        ? AbortSignal.any([ctx.signal, controller.signal])
        : controller.signal;
      prefetched.set(block.id, {
        call,
        basis: reviewBasis(ctx, config, policy),
        controller,
        // A review settling after a session switch must not become an unhandled rejection.
        result: prefetchSlot(() => review(ctx, config, call, policy.detail, blocks, signal)).catch(
          (cause: unknown) => failed(errorMessage(cause)),
        ),
        consumed: false,
      });
    }
  }

  pi.on("input", (event) => {
    if (event.source !== "extension") return;
    extensionInputs.push({
      text: event.text,
      images: (event.images?.length ?? 0) > 0,
      run: runs,
    });
    if (extensionInputs.length > maxPendingInputs) extensionInputs.shift();
  });

  pi.on("message_end", (event, ctx) => {
    const { message } = event;
    if (message.role === "user") {
      // Mark the user message an extension sent so evidence treats it as untrusted: the oldest
      // pending input whose text it carries exactly.
      const text = userText(message.content);
      const index = extensionInputs.findIndex((input) => sentBy(input, text));
      if (index < 0) {
        // A message the user typed, including steering and follow-up messages that Pi delivers
        // without `before_agent_start`, starts a new request: the Rejection Streak ends.
        streak = 0;
        ending = false;
        return;
      }
      extensionInputs.splice(index, 1);
      pi.appendEntry(extensionMessageEntryType, { version: 1, key: userMessageKey(message) });
      return;
    }
    if (message.role === "custom") {
      // In a Child Agent, a Coordination Message from its direct parent starts a new request,
      // as a typed message does in a main session, often without `before_agent_start`: the
      // Rejection Streak ends. Any such message counts, approved or not, like any typed message.
      const role = host.role();
      if (
        role.kind === "child" &&
        role.parentAgentId !== undefined &&
        isCoordinationFrom(message, role.parentAgentId)
      ) {
        streak = 0;
        ending = false;
      }
      return;
    }
    // Pi executes tool calls only from a completed tool-use response.
    if (message.role !== "assistant" || message.stopReason !== "toolUse") return;
    prefetch(
      ctx,
      message.content.flatMap((part) => (part.type === "toolCall" ? [part] : [])),
    );
  });

  pi.on("tool_call", async (event, ctx) => {
    // Snapshot the arguments first: the review and the argument-drift check judge this copy.
    const call: SeenCall = {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: structuredClone(event.input),
      parentToolCallId: event.parentToolCallId,
    };
    calls.set(call.toolCallId, call);
    const early = prefetched.get(call.toolCallId);
    const { config, error } = host.settings();
    if (error) {
      // Unreadable settings may have held deny or review rules: only built-in reads still run.
      if (early) discard(early);
      if (readOnlyBuiltIns.includes(call.toolName)) return undefined;
      return settle(ctx, config, call, failed(`Guardian settings are unavailable: ${error}`));
    }
    if (!config.enabled) {
      if (early) discard(early);
      return undefined;
    }
    if (ending) {
      if (early) discard(early);
      return { block: true, terminate: true, reason: streakEndedReason };
    }
    const batch = batchOf(call.parentToolCallId ?? call.toolCallId);
    const policy = policyFor(ctx, config, call, batch);
    if (policy.policy !== "review" && early) discard(early);
    if (policy.policy === "allow") return undefined;
    if (policy.policy === "deny")
      return {
        block: true,
        reason:
          policy.source === "command"
            ? `This command is denied by Guardian: ${policy.detail ?? "a Command Rule denies it"}; the call did not run. Do not work around it or reach the same effect another way; ask the user if this action is needed.`
            : `The ${call.toolName} tool is denied by Guardian's Tool Policy; the call did not run. Do not work around it; ask the user if this action is needed.`,
      };
    let result: ReviewResult;
    if (
      early &&
      !early.consumed &&
      early.call.toolName === call.toolName &&
      isDeepStrictEqual(early.call.input, call.input) &&
      early.basis === reviewBasis(ctx, config, policy)
    ) {
      early.consumed = true;
      result = await early.result;
    } else {
      if (early) discard(early);
      result = await review(ctx, config, call, policy.detail, batch, ctx.signal);
    }
    return settle(ctx, config, call, result);
  });

  // Pi emits `tool_result` only for calls that ran; a call another extension blocked has none.
  pi.on("tool_result", (event, ctx) => {
    const pending = pendingAudits.get(event.toolCallId);
    if (pending) {
      pendingAudits.delete(event.toolCallId);
      if (!ending) streak = 0;
      pending.entry.executed = true;
      // The agent a delegating call reached, from its result: approval is bound to it.
      const { details } = event;
      if (
        pending.entry.delegationSha256 !== undefined &&
        !event.isError &&
        Value.Check(delegationResultSchema, details)
      )
        pending.entry.delegationRecipient = details.agent_id;
      if (!isDeepStrictEqual(pending.reviewedInput, event.input)) {
        pending.entry.argumentDrift = true;
        notify(
          ctx,
          `${pending.entry.toolName} ran with arguments that changed after its review. An extension loaded after Guardian modified them; load Guardian last.`,
          "warning",
        );
      }
      append(pending.entry);
    }
  });

  /** Record early reviews whose calls never consumed them. */
  function discardPrefetches(): void {
    for (const early of prefetched.values()) discard(early);
    prefetched.clear();
  }

  function flush(): void {
    discardPrefetches();
    for (const { entry } of pendingAudits.values()) append({ ...entry, executed: false });
    pendingAudits.clear();
  }

  pi.on("turn_end", discardPrefetches);
  pi.on("agent_start", () => {
    runs++;
  });
  pi.on("agent_end", () => {
    flush();
    calls.clear();
    // An input that arrived before this run started was due as a message in it, as a prompt or a
    // queued steering or follow-up message; one still pending never became a message (another
    // handler handled or rewrote it, or its prompt failed, which Guardian cannot observe).
    // Dropped, it cannot mislabel a message the user later types with the same text; until then
    // such a message is labeled as the extension's, which errs toward untrusted. Inputs that
    // arrived during the run may still start the next one, so they wait one more run.
    const due = extensionInputs.filter((input) => input.run >= runs);
    extensionInputs.splice(0, extensionInputs.length, ...due);
  });
  pi.on("before_agent_start", () => {
    streak = 0;
    ending = false;
  });

  return {
    reviewing: () => [...reviewing.values()],
    reset() {
      for (const early of prefetched.values()) early.controller.abort();
      prefetched.clear();
      pendingAudits.clear();
      calls.clear();
      extensionInputs.length = 0;
      streak = 0;
      ending = false;
    },
    flush,
    typedUserMessages() {
      const session = host.session();
      if (!session) return [];
      const branch = session.sessionManager.getBranch();
      return typedUserMessages({
        sources: branchMessages(branch),
        extensionMessages: extensionMessages(branch),
      });
    },
    approvedDelegations() {
      const session = host.session();
      if (!session) return [];
      // Allowed calls are recorded once their results arrive; until then they are pending.
      return recordedDelegations(
        session.sessionManager.getBranch(),
        [...pendingAudits.values()].map(({ entry }) => entry),
      );
    },
  };
}
