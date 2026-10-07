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
import { rejectionReason } from "./guardian-assessment.js";
import {
  auditArguments,
  recordedOverrides,
  reviewEntryType,
  type ReviewEntry,
  type ReviewOutcome,
} from "./guardian-audit.js";
import { overrideDialogs } from "./guardian-dialog.js";
import {
  renderReviewedCall,
  selectEvidence,
  textTokens,
  userMessageKey,
  type IssuingCall,
  type ToolInput,
} from "./guardian-evidence.js";
import { contextFiles, loadedResourcePaths } from "./guardian-pi-resources.js";
import { guardianSystemPrompt } from "./guardian-prompt.js";
import { resolveGuardianModel, runGuardianReview, type ReviewResult } from "./guardian-review.js";
import type { GuardedSessionRole } from "./guardian-root-registry.js";
import { evidenceBudget, type GuardianConfig } from "./guardian-settings.js";
import type { SensitivePathContext } from "./sensitive-paths.js";
import { resolveToolPolicy, type ResolvedToolPolicy } from "./tool-policy.js";
import { TROUBLESHOOTING_HINT } from "./troubleshooting-skill.js";

/** What the review gate reads from the extension that owns the session. */
export interface ReviewGateHost {
  session(): AgentSession | undefined;
  /** Why the session is unavailable, when it is. */
  unavailable(): string;
  role(): GuardedSessionRole;
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
}

/** One call as seen by Guardian's `tool_call` handler. */
interface SeenCall {
  toolCallId: string;
  toolName: string;
  input: ToolInput;
  parentToolCallId: string | undefined;
}

/** A Guardian Review started when the assistant message ended, ahead of its call's preflight. */
interface Prefetch {
  /** The reviewed snapshot of the call, as validated for its tool. */
  call: SeenCall;
  controller: AbortController;
  result: Promise<ReviewResult>;
  consumed: boolean;
}

/** An allowed call's audit entry, held until its result shows it ran and whether it drifted. */
interface PendingAudit {
  entry: ReviewEntry;
  approved: ToolInput;
}

/** Built-in tools that only read; the only calls that run while settings are unreadable. */
const readOnlyBuiltIns: ReadonlySet<string> = new Set(["read", "grep", "find", "ls"]);
/** Early reviews running at once; the rest wait for a slot. */
const maxConcurrentPrefetches = 4;
/** Tokens kept free for the Guardian's reasoning and reply. */
const outputReserveTokens = 8_192;
/** Pi's branch summarization uses the same fallback for models without a declared window. */
const fallbackWindow = 128_000;
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

function failed(failure: string): ReviewResult {
  return { kind: "failed", failure, model: null, durationMs: 0, usage: null, cost: null };
}

function agentLabel(role: GuardedSessionRole): string {
  if (role.kind === "main") return "the main Pi agent";
  if (role.kind === "child")
    return "a Minimal Subagents Child Agent (its task comes from another agent, not the user)";
  return "an Advisor (its requests come from Pi, not the user)";
}

/** Gate tool calls with Guardian Reviews: early reviews, Tool Policies, Outcomes, and audits. */
export function installReviewGate(pi: ExtensionAPI, host: ReviewGateHost): ReviewGate {
  let streak = 0;
  /** Tool names under review, keyed per review so a superseded review cannot clear another. */
  const reviewing = new Map<symbol, string>();
  const calls = new Map<string, SeenCall>();
  const prefetched = new Map<string, Prefetch>();
  const pendingAudits = new Map<string, PendingAudit>();
  const extensionInputs: string[] = [];
  const askOverride = overrideDialogs();
  const prefetchSlot = limiter(maxConcurrentPrefetches);

  function notify(ctx: ExtensionContext, text: string, level: "warning" | "error"): void {
    if (!ctx.hasUI) return;
    try {
      ctx.ui.notify(text, level);
    } catch {
      // A replaced session's UI is stale; the review entry remains the durable record.
    }
  }

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
      loadedResources: session ? loadedResourcePaths(session) : [],
    };
  }

  /** The call's own Tool Policy. */
  function ownPolicy(
    config: GuardianConfig,
    paths: SensitivePathContext,
    toolName: string,
    input: ToolInput,
  ): ResolvedToolPolicy {
    return resolveToolPolicy({
      toolName,
      input,
      configured: config.tools,
      safeCommands: config.safeCommands,
      annotations: pi.getAllTools().find((tool) => tool.name === toolName)?.annotations,
      paths,
    });
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

  /**
   * The call's Tool Policy. A top-level edit or write that its default would allow is reviewed
   * when its batch also has a call that is not allowed without review: Pi may run them in
   * parallel, and that call could swap the target for a link while the edit is pending.
   */
  function policyFor(
    ctx: ExtensionContext,
    config: GuardianConfig,
    call: SeenCall,
    batch: readonly ToolCall[] = call.parentToolCallId ? [] : batchOf(call.toolCallId),
  ): ResolvedToolPolicy {
    const paths = pathContext(ctx);
    const own = ownPolicy(config, paths, call.toolName, call.input);
    if (own.policy !== "allow" || own.source !== "default") return own;
    if (call.toolName !== "edit" && call.toolName !== "write") return own;
    const risky = batch.some(
      (other) =>
        other.id !== call.toolCallId &&
        ownPolicy(config, paths, other.name, other.arguments).policy !== "allow",
    );
    return risky
      ? {
          policy: "review",
          source: "default",
          detail: "it shares a tool batch with a call that is not allowed without review",
        }
      : own;
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

  /** Run one Guardian Review of `call` against the current evidence. */
  async function review(
    ctx: ExtensionContext,
    config: GuardianConfig,
    call: SeenCall,
    reason: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<ReviewResult> {
    const resolved = resolveGuardianModel(config.model, ctx.modelRegistry, ctx.model);
    if (!resolved.ok) return { ...failed(resolved.failure), model: resolved.model };
    const session = host.session();
    if (!session) return failed(host.unavailable());
    const role = host.role();
    const systemPrompt = guardianSystemPrompt(config.policy);
    const reviewed = renderReviewedCall({
      toolName: call.toolName,
      input: call.input,
      cwd: ctx.cwd,
      agent: agentLabel(role),
      parent: issuingCall(call.parentToolCallId),
      reason,
    });
    // The Reviewed Call is never shortened: it must fit beside the policy and the reply.
    const capacity =
      (resolved.model.contextWindow || fallbackWindow) -
      textTokens(systemPrompt) -
      outputReserveTokens;
    const callTokens = textTokens(reviewed);
    const name = `${resolved.model.provider}/${resolved.model.id}`;
    if (callTokens > capacity)
      return {
        ...failed(
          `the call is too large for Guardian model ${name} to review in full (about ${callTokens} tokens; at most ${Math.max(0, capacity)} fit), and Guardian never reviews a shortened call`,
        ),
        model: name,
      };
    const branch = ctx.sessionManager.getBranch();
    const evidence = selectEvidence({
      sources: session.messages,
      trustUserMessages: role.kind === "main",
      contextFiles: contextFiles(session, getAgentDir()),
      extensionMessages: extensionMessages(branch),
      overrides: recordedOverrides(branch),
      budgetTokens: Math.min(
        evidenceBudget(config.evidenceBudgetTokens, resolved.model.contextWindow),
        capacity - callTokens,
      ),
    });
    const key = Symbol(call.toolCallId);
    reviewing.set(key, call.toolName);
    host.reviewingChanged();
    try {
      return await runGuardianReview({
        registry: ctx.modelRegistry,
        model: resolved.model,
        thinkingLevel: config.thinkingLevel,
        context: {
          systemPrompt,
          messages: [
            {
              role: "user",
              content: [...evidence.blocks, reviewed].map((text) => ({ type: "text", text })),
              // A fixed timestamp keeps successive requests' prefixes byte-identical.
              timestamp: 0,
            },
          ],
        },
        timeoutMs: config.reviewTimeoutMs,
        signal,
        sessionId: `pi-guardian:${ctx.sessionManager.getSessionId()}`,
      });
    } finally {
      reviewing.delete(key);
      host.reviewingChanged();
    }
  }

  function auditEntry(call: SeenCall, result: ReviewResult, outcome: ReviewOutcome): ReviewEntry {
    return {
      version: 1,
      toolName: call.toolName,
      toolCallId: call.toolCallId,
      parentToolCallId: call.parentToolCallId ?? null,
      ...auditArguments(call.input),
      risk: result.kind === "assessed" ? result.assessment.risk : null,
      authorization: result.kind === "assessed" ? result.assessment.authorization : null,
      outcome,
      rationale: result.kind === "assessed" ? result.assessment.rationale : null,
      failure: result.kind === "failed" ? result.failure : null,
      userOverride: false,
      blocked: outcome !== "allowed",
      model: result.model,
      durationMs: result.durationMs,
      usage: result.usage,
      cost: result.cost,
    };
  }

  /** Hold an allowed call's entry until its result shows that it ran. */
  function allow(call: SeenCall, entry: ReviewEntry): undefined {
    pendingAudits.set(call.toolCallId, { entry, approved: structuredClone(call.input) });
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
    if (config.maxConsecutiveRejections > 0 && streak >= config.maxConsecutiveRejections)
      result.terminate = true;
    return result;
  }

  /** Turn a review into the call's fate: allow, ask the user, or block. */
  async function settle(
    ctx: ExtensionContext,
    config: GuardianConfig,
    call: SeenCall,
    result: ReviewResult,
  ): Promise<ToolCallEventResult | undefined> {
    if (result.kind === "aborted") {
      append(auditEntry(call, result, "aborted"));
      return { block: true, reason: "Guardian Review was aborted; the call did not run." };
    }
    if (result.kind === "assessed" && result.outcome === "allowed")
      return allow(call, auditEntry(call, result, "allowed"));
    const request = {
      toolName: call.toolName,
      input: call.input,
      parent: issuingCall(call.parentToolCallId),
    };
    if (result.kind === "assessed") {
      const { risk, authorization, rationale } = result.assessment;
      notify(ctx, `Guardian rejected ${call.toolName} (${risk} risk): ${rationale}`, "warning");
      const entry = auditEntry(call, result, "rejected");
      if (
        config.onDeny === "ask" &&
        (await askOverride(ctx, {
          ...request,
          headline: `Guardian rejected ${call.toolName} — risk ${risk}, authorization ${authorization}\n${rationale}`,
        }))
      )
        return allow(call, { ...entry, userOverride: true, blocked: false });
      return blocked(config, entry, rejectionReason(result.assessment));
    }
    notify(ctx, `Guardian could not review ${call.toolName}: ${result.failure}`, "warning");
    const entry = auditEntry(call, result, "failed");
    if (
      await askOverride(ctx, {
        ...request,
        headline: `Guardian could not review ${call.toolName}: ${result.failure}`,
      })
    )
      return allow(call, { ...entry, userOverride: true, blocked: false });
    return blocked(
      config,
      entry,
      `Guardian could not review this ${call.toolName} call, so it was blocked: ${result.failure}. Do not retry it or work around it; tell the user that Guardian could not review the action and ask how to proceed.\n\n${TROUBLESHOOTING_HINT}`,
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
    if (!config.enabled || error) return;
    const tools = pi.getAllTools();
    for (const block of blocks) {
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
        controller,
        result: prefetchSlot(() => review(ctx, config, call, policy.detail, signal)),
        consumed: false,
      });
    }
  }

  pi.on("input", (event) => {
    if (event.source !== "extension" || !event.text) return;
    extensionInputs.push(event.text);
    if (extensionInputs.length > maxPendingInputs) extensionInputs.shift();
  });

  pi.on("message_end", (event, ctx) => {
    const { message } = event;
    if (message.role === "user") {
      // Mark the user message an extension sent so evidence treats it as untrusted.
      const text = Array.isArray(message.content)
        ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
        : message.content;
      const index = extensionInputs.findIndex((input) => text.startsWith(input));
      if (index < 0) return;
      extensionInputs.splice(index, 1);
      pi.appendEntry(extensionMessageEntryType, { version: 1, key: userMessageKey(message) });
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
    const call: SeenCall = {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: event.input,
      parentToolCallId: event.parentToolCallId,
    };
    calls.set(call.toolCallId, { ...call, input: structuredClone(call.input) });
    const early = prefetched.get(call.toolCallId);
    const { config, error } = host.settings();
    if (error) {
      // Unreadable settings may have held deny or review rules: only built-in reads still run.
      if (early) discard(early);
      if (readOnlyBuiltIns.has(call.toolName)) return undefined;
      return settle(ctx, config, call, failed(`Guardian settings are unavailable: ${error}`));
    }
    if (!config.enabled) {
      if (early) discard(early);
      return undefined;
    }
    const policy = policyFor(ctx, config, call);
    if (policy.policy !== "review" && early) discard(early);
    if (policy.policy === "allow") return undefined;
    if (policy.policy === "deny")
      return {
        block: true,
        reason: `The ${call.toolName} tool is denied by Guardian's Tool Policy; the call did not run. Do not work around it; ask the user if this action is needed.`,
      };
    let result: ReviewResult;
    if (
      early &&
      !early.consumed &&
      early.call.toolName === call.toolName &&
      isDeepStrictEqual(early.call.input, call.input)
    ) {
      early.consumed = true;
      result = await early.result;
    } else {
      if (early) discard(early);
      result = await review(ctx, config, call, policy.detail, ctx.signal);
    }
    return settle(ctx, config, call, result);
  });

  // Pi emits `tool_result` only for calls that ran; a call another extension blocked has none.
  pi.on("tool_result", (event, ctx) => {
    const pending = pendingAudits.get(event.toolCallId);
    if (!pending) return;
    pendingAudits.delete(event.toolCallId);
    streak = 0;
    pending.entry.executed = true;
    if (!isDeepStrictEqual(pending.approved, event.input)) {
      pending.entry.argumentDrift = true;
      notify(
        ctx,
        `Guardian: ${pending.entry.toolName} ran with arguments that changed after its review. An extension loaded after Guardian modified them; load Guardian last.`,
        "warning",
      );
    }
    append(pending.entry);
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
  pi.on("agent_end", () => {
    flush();
    calls.clear();
  });
  pi.on("before_agent_start", () => {
    streak = 0;
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
    },
    flush,
  };
}
