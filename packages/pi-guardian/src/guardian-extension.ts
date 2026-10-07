import * as piSdk from "@earendil-works/pi-coding-agent";
import type {
  AgentSession,
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
  ExtensionUIDialogOptions,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { discoverPiAgentSession } from "@ian-pascoe/pi-utils/pi-agent-session-discovery";
import { isDeepStrictEqual } from "node:util";
import { rejectionReason } from "./guardian-assessment.js";
import {
  auditArguments,
  recordedOverrides,
  reviewEntryType,
  reviewTotals,
  type ReviewEntry,
  type ReviewOutcome,
} from "./guardian-audit.js";
import {
  parseGuardianCommand,
  completeGuardianCommandArguments,
  updatedToolEntries,
} from "./guardian-command.js";
import {
  projectInstructions,
  renderReviewedCall,
  selectEvidence,
  type IssuingCall,
  type ToolInput,
} from "./guardian-evidence.js";
import {
  GuardianSettingsMenu,
  type GuardianMenuHost,
  type GuardianScopedOptions,
} from "./guardian-menu.js";
import { guardianSystemPrompt } from "./guardian-prompt.js";
import {
  guardianFooterText,
  guardianStatusHeadline,
  renderReviewEntry,
  renderStatusEntry,
  statusEntryType,
  type GuardianRenderTheme,
  type GuardianStatusEntry,
} from "./guardian-rendering.js";
import { resolveGuardianModel, runGuardianReview, type ReviewResult } from "./guardian-review.js";
import {
  guardedSessionRole,
  publishRootSettings,
  rootSettingsReader,
  type GuardedSessionRole,
} from "./guardian-root-registry.js";
import {
  evidenceBudget,
  guardianDefaults,
  parseGuardianOptions,
  readGuardianLayers,
  readGuardianOverrides,
  readGuardianSettings,
  writeGuardianSettings,
  type GuardianAppliedChange,
  type GuardianChange,
  type GuardianConfig,
  type GuardianLayers,
  type GuardianSettingScope,
  type ResolvedGuardianSettings,
} from "./guardian-settings.js";
import { resolveToolPolicy, type ResolvedToolPolicy } from "./tool-policy.js";
import { TROUBLESHOOTING_HINT } from "./troubleshooting-skill.js";

/** Effective settings for this session, or why they cannot be read. */
type Effective =
  | { ok: true; resolved: ResolvedGuardianSettings; followsRoot: string | null }
  | { ok: false; error: string };

/** One call as seen by Guardian's `tool_call` handler. */
interface SeenCall {
  toolCallId: string;
  toolName: string;
  input: ToolInput;
  parentToolCallId: string | undefined;
}

/** A Guardian Review started when the assistant message ended, ahead of its call's preflight. */
interface Prefetch {
  /** The call as the assistant message issued it. */
  call: SeenCall;
  input: ToolInput;
  controller: AbortController;
  result: Promise<ReviewResult>;
  consumed: boolean;
}

/** An allowed call's audit entry, held until its result shows whether its arguments drifted. */
interface PendingAudit {
  entry: ReviewEntry;
  approved: ToolInput;
}

const choices = { block: "Block", allow: "Allow once" } as const;

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Gate the Guarded Agent's tool calls with Guardian Reviews; see the package README. */
export default function guardian(pi: ExtensionAPI): void {
  let session: AgentSession | undefined;
  let discoveryError: string | undefined;
  let layers: GuardianLayers = { global: {}, project: {} };
  let role: GuardedSessionRole = { kind: "main" };
  let unpublish: (() => void) | undefined;
  let footer: ExtensionUIContext | undefined;
  let activeMenu: { refresh: () => void; close: () => void } | undefined;
  let generation = 0;
  let streak = 0;
  /** Tool names under review, keyed per review so a superseded review cannot clear another. */
  const reviewing = new Map<symbol, string>();
  const calls = new Map<string, SeenCall>();
  const prefetched = new Map<string, Prefetch>();
  const pendingAudits = new Map<string, PendingAudit>();

  pi.registerEntryRenderer(reviewEntryType, (entry, { expanded }, theme) =>
    renderReviewEntry(entry.data, expanded, theme),
  );
  pi.registerEntryRenderer(statusEntryType, (entry, { expanded }, theme) =>
    renderStatusEntry(entry.data, expanded, theme),
  );

  /** Effective settings: the root session's for Child Agents and Advisors, else this session's. */
  function effective(): Effective {
    try {
      if (role.kind !== "main") {
        const read = rootSettingsReader(role.rootSessionId);
        if (read) return { ok: true, resolved: read(), followsRoot: role.rootSessionId };
      }
      if (!session)
        return { ok: false, error: discoveryError ?? "Guardian session is unavailable" };
      return { ok: true, resolved: readGuardianSettings(session, layers), followsRoot: null };
    } catch (cause) {
      return { ok: false, error: message(cause) };
    }
  }

  /** Settings to enforce: on a settings error, defaults whose reviews all fail closed. */
  function enforced(): { config: GuardianConfig; error: string | undefined } {
    const current = effective();
    return current.ok
      ? { config: current.resolved.settings, error: undefined }
      : { config: guardianDefaults, error: current.error };
  }

  function publishFooter(): void {
    activeMenu?.refresh();
    if (!footer) return;
    const current = effective();
    try {
      footer.setStatus(
        "guardian",
        current.ok
          ? guardianFooterText(
              current.resolved.settings.enabled,
              [...reviewing.values()],
              footer.theme,
            )
          : footer.theme.fg("error", "guardian: settings error"),
      );
    } catch {
      // A replaced session's UI is stale; status entries remain authoritative.
    }
  }

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

  function policyFor(
    ctx: ExtensionContext,
    config: GuardianConfig,
    toolName: string,
    input: ToolInput,
  ): ResolvedToolPolicy {
    return resolveToolPolicy({
      toolName,
      input,
      configured: config.tools,
      safeCommands: config.safeCommands,
      annotations: pi.getAllTools().find((tool) => tool.name === toolName)?.annotations,
      paths: {
        cwd: ctx.cwd,
        piDirectories: [piSdk.getAgentDir(), ctx.sessionManager.getSessionDir()].filter(Boolean),
      },
    });
  }

  /** The issuing call of a nested call, from calls seen this run or the transcript. */
  function issuingCall(parentToolCallId: string | undefined): IssuingCall | undefined {
    if (parentToolCallId === undefined) return undefined;
    const seen = calls.get(parentToolCallId);
    if (seen) return { toolName: seen.toolName, input: seen.input };
    for (const entry of session?.messages.toReversed() ?? []) {
      if (entry.role !== "assistant") continue;
      const block = entry.content.find(
        (part) => part.type === "toolCall" && part.id === parentToolCallId,
      );
      if (block?.type === "toolCall") return { toolName: block.name, input: block.arguments };
    }
    return { toolName: "unknown", input: { toolCallId: parentToolCallId } };
  }

  /** Run one Guardian Review of `call` against the current evidence. */
  async function review(
    ctx: ExtensionContext,
    config: GuardianConfig,
    call: SeenCall,
    signal: AbortSignal | undefined,
  ): Promise<ReviewResult> {
    const resolved = resolveGuardianModel(config.model, ctx.modelRegistry, ctx.model);
    const unmeasured = { model: null, durationMs: 0, usage: null, cost: null };
    if (!resolved.ok)
      return { kind: "failed", failure: resolved.failure, ...unmeasured, model: resolved.model };
    if (!session)
      return {
        kind: "failed",
        failure: discoveryError ?? "Guardian session is unavailable",
        ...unmeasured,
      };
    let systemPrompt = "";
    try {
      systemPrompt = ctx.getSystemPrompt();
    } catch {
      // Without the Guarded Agent's system prompt, project instructions are simply absent.
    }
    const evidence = selectEvidence({
      sources: session.messages,
      trustUserMessages: role.kind === "main",
      projectInstructions: projectInstructions(systemPrompt),
      overrides: recordedOverrides(ctx.sessionManager.getBranch()),
      budgetTokens: evidenceBudget(config.evidenceBudgetTokens, resolved.model.contextWindow),
    });
    const reviewed = renderReviewedCall({
      toolName: call.toolName,
      input: call.input,
      cwd: ctx.cwd,
      agent:
        role.kind === "main"
          ? "the main Pi agent"
          : role.kind === "child"
            ? "a Minimal Subagents Child Agent (its task comes from another agent, not the user)"
            : "an Advisor (its requests come from Pi, not the user)",
      parent: issuingCall(call.parentToolCallId),
    });
    const key = Symbol(call.toolCallId);
    reviewing.set(key, call.toolName);
    publishFooter();
    try {
      return await runGuardianReview({
        registry: ctx.modelRegistry,
        model: resolved.model,
        thinkingLevel: config.thinkingLevel,
        context: {
          systemPrompt: guardianSystemPrompt(config.policy),
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
      publishFooter();
    }
  }

  function auditEntry(call: SeenCall, result: ReviewResult, outcome: ReviewOutcome): ReviewEntry {
    return {
      version: 1,
      toolName: call.toolName,
      toolCallId: call.toolCallId,
      parentToolCallId: call.parentToolCallId ?? null,
      arguments: auditArguments(call.input),
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

  /** Ask an interactive user to allow a call once; anything but an explicit allow blocks. */
  async function askOverride(ctx: ExtensionContext, title: string): Promise<boolean> {
    if (!ctx.hasUI) return false;
    try {
      const options: ExtensionUIDialogOptions = {};
      if (ctx.signal) options.signal = ctx.signal;
      const choice = await ctx.ui.select(title, [choices.block, choices.allow], options);
      return choice === choices.allow && !ctx.signal?.aborted;
    } catch {
      return false;
    }
  }

  /** Hold an allowed call's entry until its result, to detect argument drift. */
  function allow(call: SeenCall, entry: ReviewEntry): undefined {
    streak = 0;
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
    if (result.kind === "assessed") {
      const { risk, authorization, rationale } = result.assessment;
      notify(ctx, `Guardian rejected ${call.toolName} (${risk} risk): ${rationale}`, "warning");
      const entry = auditEntry(call, result, "rejected");
      if (
        config.onDeny === "ask" &&
        (await askOverride(
          ctx,
          `Guardian rejected ${call.toolName} — risk ${risk}, authorization ${authorization}\n${rationale}\nArguments: ${entry.arguments}`,
        ))
      )
        return allow(call, { ...entry, userOverride: true, blocked: false });
      return blocked(config, entry, rejectionReason(result.assessment));
    }
    notify(ctx, `Guardian could not review ${call.toolName}: ${result.failure}`, "warning");
    const entry = auditEntry(call, result, "failed");
    if (
      await askOverride(
        ctx,
        `Guardian could not review ${call.toolName}: ${result.failure}\nArguments: ${entry.arguments}`,
      )
    )
      return allow(call, { ...entry, userOverride: true, blocked: false });
    return blocked(
      config,
      entry,
      `Guardian could not review this ${call.toolName} call, so it was blocked: ${result.failure}. Do not retry it or work around it; tell the user that Guardian could not review the action and ask how to proceed.\n\n${TROUBLESHOOTING_HINT}`,
    );
  }

  /** Record an unconsumed prefetched review once it settles. */
  function discard(call: SeenCall, prefetch: Prefetch): void {
    if (prefetch.consumed) return;
    prefetch.consumed = true;
    prefetch.controller.abort();
    void prefetch.result.then((result) => {
      if (result.usage || result.durationMs > 0) append(auditEntry(call, result, "unused"));
    });
  }

  pi.on("message_end", (event, ctx) => {
    // Pi executes tool calls only from a completed tool-use response.
    if (event.message.role !== "assistant" || event.message.stopReason !== "toolUse") return;
    const { config, error } = enforced();
    if (!config.enabled || error) return;
    for (const block of event.message.content) {
      if (block.type !== "toolCall" || prefetched.has(block.id)) continue;
      const call: SeenCall = {
        toolCallId: block.id,
        toolName: block.name,
        input: structuredClone(block.arguments),
        parentToolCallId: undefined,
      };
      if (policyFor(ctx, config, call.toolName, call.input).policy !== "review") continue;
      const controller = new AbortController();
      const signal = ctx.signal
        ? AbortSignal.any([ctx.signal, controller.signal])
        : controller.signal;
      prefetched.set(block.id, {
        call,
        input: call.input,
        controller,
        // Started now so parallel calls are reviewed concurrently; Pi runs preflight serially.
        result: review(ctx, config, call, signal),
        consumed: false,
      });
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    const call: SeenCall = {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: event.input,
      parentToolCallId: event.parentToolCallId,
    };
    calls.set(call.toolCallId, { ...call, input: structuredClone(call.input) });
    const prefetch = prefetched.get(call.toolCallId);
    const { config, error } = enforced();
    if (!config.enabled && !error) {
      if (prefetch) discard(call, prefetch);
      return undefined;
    }
    const policy = policyFor(ctx, config, call.toolName, call.input);
    if (policy.policy !== "review" && prefetch) discard(call, prefetch);
    if (policy.policy === "allow") return undefined;
    if (policy.policy === "deny")
      return {
        block: true,
        reason: `The ${call.toolName} tool is denied by Guardian's Tool Policy; the call did not run. Do not work around it; ask the user if this action is needed.`,
      };
    if (error) {
      const failure: ReviewResult = {
        kind: "failed",
        failure: `Guardian settings are unavailable: ${error}`,
        model: null,
        durationMs: 0,
        usage: null,
        cost: null,
      };
      return settle(ctx, config, call, failure);
    }
    let result: ReviewResult;
    if (prefetch && !prefetch.consumed && isDeepStrictEqual(prefetch.input, call.input)) {
      prefetch.consumed = true;
      result = await prefetch.result;
    } else {
      if (prefetch) discard(call, prefetch);
      result = await review(ctx, config, call, ctx.signal);
    }
    return settle(ctx, config, call, result);
  });

  pi.on("tool_result", (event, ctx) => {
    const pending = pendingAudits.get(event.toolCallId);
    if (!pending) return;
    pendingAudits.delete(event.toolCallId);
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

  /** Record reviews started ahead of calls that never consumed them. */
  function discardPrefetches(): void {
    for (const prefetch of prefetched.values()) discard(prefetch.call, prefetch);
    prefetched.clear();
  }

  /** Record held and unconsumed reviews when their calls can no longer report. */
  function flush(): void {
    discardPrefetches();
    for (const { entry } of pendingAudits.values()) append(entry);
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

  pi.on("session_start", (_event, ctx) => {
    activeMenu?.close();
    generation++;
    // The previous session's reviews were recorded at its shutdown; drop what remains.
    for (const prefetch of prefetched.values()) prefetch.controller.abort();
    prefetched.clear();
    pendingAudits.clear();
    calls.clear();
    streak = 0;
    unpublish?.();
    unpublish = undefined;
    role = guardedSessionRole(ctx.sessionManager.getBranch());
    footer = ctx.hasUI ? ctx.ui : undefined;
    const found = discoverPiAgentSession(pi, piSdk.AgentSession);
    if (found.ok) {
      session = found.session;
      discoveryError = undefined;
      try {
        layers = readGuardianLayers(session.settingsManager);
      } catch (cause) {
        layers = { global: new Error(message(cause)), project: {} };
      }
    } else {
      session = undefined;
      discoveryError = `Guardian cannot read this session's settings: ${found.warning}`;
    }
    if (role.kind === "main" && session) {
      const subject = session;
      unpublish = publishRootSettings(ctx.sessionManager.getSessionId(), () =>
        readGuardianSettings(subject, layers),
      );
    }
    const current = effective();
    if (!current.ok)
      notify(ctx, `Guardian: ${current.error}. Run /skill:pi-guardian to diagnose.`, "error");
    publishFooter();
  });
  pi.on("session_tree", () => {
    activeMenu?.close();
    generation++;
    publishFooter();
  });
  pi.on("session_shutdown", () => {
    activeMenu?.close();
    generation++;
    flush();
    unpublish?.();
    unpublish = undefined;
    session = undefined;
    footer = undefined;
  });

  /** Effective settings, totals, and any error, as recorded in status entries. */
  function statusData(ctx: ExtensionContext): GuardianStatusEntry {
    const totals = reviewTotals(ctx.sessionManager.getBranch());
    const current = effective();
    if (!current.ok) return { state: "error", totals, error: current.error };
    const { settings, sources } = current.resolved;
    return {
      state: settings.enabled ? "enabled" : "disabled",
      settings,
      sources,
      followsRoot: current.followsRoot,
      totals,
      error: null,
    };
  }

  function status(
    ctx: ExtensionContext,
    changes: readonly GuardianAppliedChange[] = [],
    error?: string,
  ): void {
    const entry = statusData(ctx);
    if (changes.length) entry.changes = [...changes];
    if (error) entry.error = error;
    pi.appendEntry(statusEntryType, entry);
    if (entry.error) notify(ctx, `Guardian: ${entry.error}`, "error");
  }

  /** The authored `tools` option at one scope. */
  function authoredTools(subject: AgentSession, scope: GuardianSettingScope) {
    if (scope === "session") return readGuardianOverrides(subject.sessionManager).tools;
    const layer = layers[scope];
    if (layer instanceof Error) throw layer;
    return layer.tools;
  }

  /** Persist one validated change at its scope; undefined if superseded. */
  async function applyChange(
    subject: AgentSession,
    scope: GuardianSettingScope,
    change: GuardianChange,
    isCurrent: () => boolean,
  ): Promise<GuardianAppliedChange | undefined> {
    if (role.kind !== "main" && rootSettingsReader(role.rootSessionId))
      throw new Error(
        "This session follows its root session's Guardian settings; change them there",
      );
    if (scope === "session") {
      const overrides = readGuardianOverrides(subject.sessionManager);
      if (change.action === "inherit") delete overrides[change.key];
      else Object.assign(overrides, change.patch);
      pi.appendEntry("pi-guardian-settings", { version: 1, overrides });
    } else {
      const updated = await writeGuardianSettings(
        subject.settingsManager,
        scope,
        change,
        isCurrent,
      );
      if (!isCurrent() || !updated) return undefined;
      layers[scope] = updated;
    }
    publishFooter();
    return { scope, key: change.key, options: change.action === "inherit" ? {} : change.patch };
  }

  function menuHost(
    ctx: ExtensionContext,
    subject: AgentSession,
    theme: GuardianRenderTheme,
    applied: GuardianAppliedChange[],
  ): GuardianMenuHost {
    return {
      view() {
        const data = statusData(ctx);
        const authored: Partial<GuardianScopedOptions> = {
          session: readGuardianOverrides(subject.sessionManager),
        };
        if (!(layers.project instanceof Error)) authored.project = layers.project;
        if (!(layers.global instanceof Error)) authored.global = layers.global;
        return {
          headline: guardianStatusHeadline(data, theme),
          scopes: subject.settingsManager.isProjectTrusted()
            ? ["session", "project", "global"]
            : ["session", "global"],
          settings: data.settings ?? {},
          sources: data.sources ?? {},
          authored,
          models: ctx.modelRegistry.getAvailable().map((model) => `${model.provider}/${model.id}`),
          tools: pi.getAllTools().map((tool) => tool.name),
        };
      },
      async apply(scope, change) {
        const stamp = ++generation;
        const result = await applyChange(
          subject,
          scope,
          change,
          () => generation === stamp && session === subject,
        );
        if (result) applied.push(result);
      },
    };
  }

  async function openMenu(ctx: ExtensionContext, subject: AgentSession): Promise<void> {
    const applied: GuardianAppliedChange[] = [];
    let discarded = false;
    let menu: GuardianSettingsMenu | undefined;
    await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
      const opened = new GuardianSettingsMenu(
        menuHost(ctx, subject, theme, applied),
        {
          tui,
          keybindings,
          theme,
          externalEditorCommand: subject.settingsManager.getExternalEditorCommand(),
        },
        () => done(),
      );
      menu = opened;
      activeMenu = {
        refresh: () => {
          opened.refresh();
          tui.requestRender();
        },
        close: () => {
          discarded = true;
          activeMenu = undefined;
          done();
        },
      };
      return opened;
    });
    activeMenu = undefined;
    await menu?.settled();
    if (!discarded && session === subject && applied.length) status(ctx, applied);
  }

  pi.registerCommand("guardian", {
    description: "Guardian settings menu, or on, off, status, policy, tool, inherit, and set",
    getArgumentCompletions: completeGuardianCommandArguments,
    async handler(args, ctx) {
      const subject = session;
      let stamp = generation;
      const isCurrent = () => generation === stamp && session === subject;
      let applied: GuardianAppliedChange | undefined;
      let error: string | undefined;
      try {
        const command = parseGuardianCommand(args);
        if (command.action === "status" || (command.action === "menu" && ctx.mode !== "tui")) {
          status(ctx);
          return;
        }
        if (!subject) throw new Error(discoveryError ?? "Guardian session is unavailable");
        if (command.action === "menu") {
          await openMenu(ctx, subject);
          return;
        }
        stamp = ++generation;
        let change: GuardianChange;
        if (command.action === "policy") {
          if (!ctx.hasUI)
            throw new Error(
              "Editing the Security Policy requires UI; use /guardian set policy <JSON>",
            );
          const current = effective();
          const edited = await ctx.ui.editor(
            "Guardian Security Policy",
            current.ok ? current.resolved.settings.policy : "",
          );
          if (!isCurrent() || edited === undefined) return;
          change = {
            action: "set",
            key: "policy",
            patch: parseGuardianOptions({ policy: edited }, command.scope),
          };
        } else if (command.action === "tool") {
          const tools = updatedToolEntries(
            authoredTools(subject, command.scope),
            command.name,
            command.value,
          );
          change = tools
            ? { action: "set", key: "tools", patch: parseGuardianOptions({ tools }, command.scope) }
            : { action: "inherit", key: "tools" };
        } else change = command;
        applied = await applyChange(subject, command.scope, change, isCurrent);
      } catch (cause) {
        if (!isCurrent()) return;
        error = message(cause);
      }
      if (isCurrent()) status(ctx, applied ? [applied] : [], error);
    },
  });
}
