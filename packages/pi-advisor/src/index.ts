import * as piSdk from "@earendil-works/pi-coding-agent";
import type {
  AgentSession,
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { isDeepStrictEqual } from "node:util";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { discoverPiAgentSession } from "@ian-pascoe/pi-utils/pi-agent-session-discovery";
import {
  parseAdvisorOptions,
  readAdvisorLayers,
  readAdvisorOverrides,
  readAdvisorSettings,
  writeAdvisorSettings,
  type AdvisorLayers,
  type AdvisorChange,
  type AdvisorAppliedChange,
  type AdvisorConfig,
  type AdvisorSettingScope,
} from "./advisor-settings.js";
import {
  AdvisorSettingsMenu,
  type AdvisorMenuHost,
  type AdvisorScopedOptions,
} from "./advisor-menu.js";
import {
  advisorFooterText,
  advisorStatusHeadline,
  renderAdvisorAskCall,
  renderAdvisorAskResult,
  renderAdvisorChildEntry,
  renderAdvisorIntervention,
  renderAdvisorStatus,
  type AdvisorActivity,
  type AdvisorRenderTheme,
  type AdvisorStatusEntry,
} from "./advisor-rendering.js";
import { completeAdvisorCommandArguments, parseAdvisorCommand } from "./advisor-command.js";
import { AdvisorObserver } from "./advisor-observer.js";
import { isAdvisorSession, type AdvisorResourceInputs } from "./advisor-session.js";
import { TROUBLESHOOTING_HINT } from "./troubleshooting-skill.js";

interface WatchedChild {
  agentId: string;
  resourceInputs: AdvisorResourceInputs;
  observer: AdvisorObserver | undefined;
}
const askToolName = "advisor_ask";
const askToolParameters = Type.Object(
  { message: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);
const childRequestSchema = Type.Object({
  rootSessionId: Type.String(),
  agentId: Type.String(),
  session: Type.Unknown(),
  attach: Type.Function([Type.Unknown()], Type.Void()),
  resourceInputs: Type.Object({
    agentDir: Type.String({ minLength: 1 }),
    extensions: Type.Array(Type.Unknown()),
    flagValues: Type.Unknown(),
    codemodeModels: Type.Optional(Type.Boolean()),
  }),
});

/** Review an observed session without changing its tools or standing instructions. */
export default function advisor(pi: ExtensionAPI): void {
  let warn: (message: string) => void = () => {};
  let footer: ExtensionUIContext | undefined;
  /** The open settings menu, refreshed on state changes and closed on session changes. */
  let activeMenu: { refresh: () => void; close: () => void } | undefined;
  let observed: AgentSession | undefined;
  let error: string | undefined;
  let layers: AdvisorLayers = { global: {}, project: {} };
  let generation = 0;
  let privateSession = false;
  let observer: AdvisorObserver | undefined;
  let askToolRegistered = false;
  let rootSessionId: string | undefined;
  const children = new Map<AgentSession, WatchedChild>();
  let unsubscribe: (() => void) | undefined = pi.events.on(
    "pi-minimal-subagents:observe-session",
    attachChild,
  );

  pi.registerEntryRenderer("pi-advisor-child", (entry, { expanded }, theme) =>
    renderAdvisorChildEntry(entry.data, expanded, theme),
  );
  pi.registerEntryRenderer("pi-advisor-status", (entry, { expanded }, theme) =>
    renderAdvisorStatus(entry.data, expanded, theme),
  );
  pi.registerMessageRenderer("pi-advisor", (message, options, theme) =>
    renderAdvisorIntervention(message.details, options, theme),
  );

  /** Show the current Advisor state in the open settings menu and the footer. */
  function publishState(): void {
    activeMenu?.refresh();
    if (!footer) return;
    const root: AdvisorActivity | undefined =
      observer?.status ?? (observed && error ? { state: "paused", backlog: 0 } : undefined);
    const watched = [...children.values()].flatMap((child) =>
      child.observer ? [child.observer.status] : [],
    );
    try {
      footer.setStatus("advisor", advisorFooterText(root, watched, footer.theme));
    } catch {
      // A replaced session's UI is stale; status entries remain authoritative.
    }
  }

  function setAskToolAvailable(available: boolean): void {
    if (available && !askToolRegistered) {
      pi.registerTool({
        name: askToolName,
        label: "Ask Advisor",
        description:
          "Ask the enabled Advisor for analysis or a second opinion. Waits for its answer; does not delegate implementation.",
        parameters: askToolParameters,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        executionMode: "sequential",
        renderCall: (args, theme, context) => renderAdvisorAskCall(args, context.expanded, theme),
        renderResult: (result, options, theme, context) =>
          renderAdvisorAskResult(
            result.content.map((item) => (item.type === "text" ? item.text : "")).join(""),
            { expanded: options.expanded, isPartial: options.isPartial, isError: context.isError },
            theme,
          ),
        execute: async (_id, { message }, signal) => {
          try {
            const current = observer;
            if (!current)
              throw new Error(
                `${error ?? "Advisor consultation is unavailable"}. Inspect /advisor status, then run /advisor on or correct its configuration.`,
              );
            const answer = await current.consult(message, signal);
            return { content: [{ type: "text", text: answer }], details: {} };
          } catch (cause) {
            // Caller cancellation is not a malfunction the Skill diagnoses.
            if (signal?.aborted) throw cause;
            const text = cause instanceof Error ? cause.message : String(cause);
            throw new Error(`${text}\n\n${TROUBLESHOOTING_HINT}`, { cause });
          }
        },
      });
      askToolRegistered = true;
      return;
    }
    if (!askToolRegistered) return;
    const active = pi.getActiveTools();
    if (available === active.includes(askToolName)) return;
    pi.setActiveTools(
      available ? [...active, askToolName] : active.filter((name) => name !== askToolName),
    );
  }

  pi.on("session_start", async (_event, ctx) => {
    activeMenu?.close();
    const stamp = ++generation;
    const previous = observer;
    observer = undefined;
    await previous?.dispose();
    if (stamp !== generation) return;
    if (rootSessionId !== ctx.sessionManager.getSessionId()) {
      await Promise.all(
        [...children.values()].map(async (child) => {
          await child.observer?.dispose();
        }),
      );
      children.clear();
    }
    rootSessionId = ctx.sessionManager.getSessionId();
    unsubscribe ??= pi.events.on("pi-minimal-subagents:observe-session", attachChild);
    observed = undefined;
    error = undefined;
    privateSession =
      isAdvisorSession(ctx.sessionManager) ||
      ctx.sessionManager
        .getBranch()
        .some(
          (entry) => entry.type === "custom" && entry.customType === "minimal-subagents.identity",
        );
    if (privateSession) {
      setAskToolAvailable(false);
      return;
    }
    const { ui } = ctx;
    footer = ctx.hasUI ? ui : undefined;
    warn = (message) => {
      try {
        ui.notify(message, "warning");
      } catch {
        // A replaced session's UI is stale; the native status entry remains the durable record.
      }
    };
    const found = discoverPiAgentSession(pi, piSdk.AgentSession);
    if (found.ok) {
      observed = found.session;
      layers = readAdvisorLayers(observed.settingsManager);
      await refresh(ctx);
    } else {
      error = found.warning;
      setAskToolAvailable(true);
    }
  });
  pi.on("session_tree", async (_event, ctx) => {
    activeMenu?.close();
    generation++;
    observer?.reset();
    for (const child of children.values()) child.observer?.reset();
    await refresh(ctx);
  });
  pi.on("model_select", () => observer?.reset());
  pi.on("before_agent_start", () => observer?.beforeTask());
  pi.on("agent_settled", () => observer?.settled());
  pi.on("session_shutdown", async () => {
    activeMenu?.close();
    generation++;
    observed = undefined;
    unsubscribe?.();
    unsubscribe = undefined;
    await Promise.all([
      observer?.dispose(),
      ...[...children.values()].map((child) => child.observer?.dispose()),
    ]);
    observer = undefined;
    children.clear();
    publishState();
    footer = undefined;
  });

  function configureChild(
    session: AgentSession,
    child: WatchedChild,
    settings: AdvisorConfig,
  ): void {
    const config = { ...settings, enabled: settings.enabled && settings.includeSubagents };
    if (child.observer) child.observer.configure(config);
    else
      child.observer = new AdvisorObserver(session, config, "owned-child", {
        resourceInputs: child.resourceInputs,
        onError: (message) => {
          if (children.get(session) !== child) return;
          pi.appendEntry("pi-advisor-child", {
            agentId: child.agentId,
            state: "paused",
            error: message,
          });
          warn(`Advisor for ${child.agentId} paused: ${message}`);
        },
        onStateChange: publishState,
        onIntervention: (finding) => {
          if (children.get(session) === child)
            pi.appendEntry("pi-advisor-child", { agentId: child.agentId, ...finding });
        },
      });
  }

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: The native owner bus is a boundary; validate identity, SDK instance, and exact resource metadata before attachment.
  function attachChild(payload: unknown): void {
    if (
      !Value.Check(childRequestSchema, payload) ||
      !(payload.session instanceof piSdk.AgentSession)
    )
      return;
    if (!observed) {
      const found = discoverPiAgentSession(pi, piSdk.AgentSession);
      if (!found.ok) return;
      observed = found.session;
      layers = readAdvisorLayers(observed.settingsManager);
      rootSessionId = observed.sessionManager.getSessionId();
    }
    if (privateSession || payload.rootSessionId !== rootSessionId || children.has(payload.session))
      return;
    const resources = payload.session.resourceLoader.getExtensions();
    const extensions = resources.extensions.map(({ path, resolvedPath, sourceInfo, hidden }) => ({
      path,
      resolvedPath,
      sourceInfo,
      hidden,
    }));
    if (
      !isDeepStrictEqual(extensions, payload.resourceInputs.extensions) ||
      !isDeepStrictEqual(resources.runtime.flagValues, payload.resourceInputs.flagValues)
    )
      return;
    const child: WatchedChild = {
      agentId: payload.agentId,
      resourceInputs: {
        agentDir: payload.resourceInputs.agentDir,
        extensions,
        flagValues: new Map(resources.runtime.flagValues),
        codemodeModels: payload.resourceInputs.codemodeModels,
      },
      observer: undefined,
    };
    const session = payload.session;
    children.set(session, child);
    try {
      configureChild(session, child, readAdvisorSettings(observed, layers).settings);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
    // A new child observer reports no state change until it reviews; show it now.
    publishState();
    payload.attach({
      beginTurn: () => child.observer?.beforeTask(),
      finishTurn: async () => {
        await child.observer?.finishOwnedTurn();
      },
      abort: async () => {
        await child.observer?.abort();
      },
      dispose: async () => {
        children.delete(session);
        await child.observer?.dispose();
      },
    });
  }

  async function refresh(ctx: ExtensionContext): Promise<void> {
    if (!observed || privateSession) return;
    try {
      const { settings } = readAdvisorSettings(observed, layers);
      if (observer) observer.configure(settings);
      else
        observer = new AdvisorObserver(
          observed,
          settings,
          ctx.hasUI ? "interactive" : "headless-root",
          {
            onError: (message) => {
              pi.appendEntry("pi-advisor-status", { state: "paused", error: message });
              warn(`Advisor paused: ${message}`);
            },
            onStateChange: publishState,
          },
        );
      for (const [session, child] of children) configureChild(session, child, settings);
      setAskToolAvailable(settings.enabled);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      setAskToolAvailable(true);
      await Promise.all([
        observer?.dispose(),
        ...[...children.values()].map((child) => child.observer?.dispose()),
      ]);
      observer = undefined;
      for (const child of children.values()) child.observer = undefined;
    }
    publishState();
  }

  /** Current effective settings and live Advisor state, as recorded in status entries. */
  function statusData(subject: AgentSession): AdvisorStatusEntry {
    const resolved = readAdvisorSettings(subject, layers);
    const live = observer?.status;
    return {
      state: live?.state ?? (resolved.settings.enabled ? "armed" : "disabled"),
      ...resolved,
      backlog: live?.backlog ?? 0,
      effectiveModel: live?.effectiveModel ?? null,
      effectiveThinkingLevel: live?.effectiveThinkingLevel ?? null,
      usage: live?.usage ?? null,
      cost: live?.cost ?? null,
      reviewCost: live?.reviewCost ?? null,
      deferredFindings: live?.deferredFindings ?? 0,
      droppedFindings: live?.droppedFindings ?? {
        overNitCap: 0,
        unsupported: 0,
        superseded: 0,
        invalid: 0,
      },
      unavailableTools: live?.unavailableTools ?? null,
      children: [...children.values()].map((child) => ({
        agentId: child.agentId,
        ...child.observer?.status,
      })),
      lastError: live?.lastError ?? null,
      error: error ?? live?.lastError ?? null,
    };
  }

  function status(ctx: ExtensionContext, changes: readonly AdvisorAppliedChange[] = []): void {
    try {
      if (!observed) throw new Error(error ?? "Advisor session is unavailable");
      const entry = statusData(observed);
      if (changes.length) entry.changes = [...changes];
      pi.appendEntry("pi-advisor-status", entry);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      pi.appendEntry("pi-advisor-status", { state: "paused", error, usage: null, cost: null });
    }
    if (error) ctx.ui.notify(`Advisor: ${error}`, "error");
  }

  /** Persist one validated change at its scope and reconfigure; undefined if superseded. */
  async function applyChange(
    ctx: ExtensionContext,
    subject: AgentSession,
    scope: AdvisorSettingScope,
    change: AdvisorChange,
    isCurrent: () => boolean,
  ): Promise<AdvisorAppliedChange | undefined> {
    if (scope === "session") {
      const overrides = readAdvisorOverrides(subject.sessionManager);
      if (change.action === "inherit") delete overrides[change.key];
      else Object.assign(overrides, change.patch);
      pi.appendEntry("pi-advisor-settings", { version: 1, overrides });
    } else {
      const updated = await writeAdvisorSettings(subject.settingsManager, scope, change, isCurrent);
      if (!isCurrent() || !updated) return undefined;
      layers[scope] = updated;
    }
    error = undefined;
    await refresh(ctx);
    return { scope, key: change.key, options: change.action === "inherit" ? {} : change.patch };
  }

  /** The settings menu's view of this extension's settings authority. */
  function menuHost(
    ctx: ExtensionContext,
    subject: AgentSession,
    theme: AdvisorRenderTheme,
    applied: AdvisorAppliedChange[],
  ): AdvisorMenuHost {
    return {
      view() {
        const data = statusData(subject);
        const authored: Partial<AdvisorScopedOptions> = {
          session: readAdvisorOverrides(subject.sessionManager),
        };
        if (!(layers.project instanceof Error)) authored.project = layers.project;
        if (!(layers.global instanceof Error)) authored.global = layers.global;
        return {
          headline: advisorStatusHeadline(data, theme),
          paused: data.state === "paused",
          scopes: subject.settingsManager.isProjectTrusted()
            ? ["session", "project", "global"]
            : ["session", "global"],
          settings: data.settings ?? {},
          sources: data.sources ?? {},
          authored,
          models: ctx.modelRegistry.getAvailable().map((model) => `${model.provider}/${model.id}`),
          tools: pi
            .getAllTools()
            .map((tool) => tool.name)
            .filter((name) => name !== askToolName),
        };
      },
      async apply(scope, change) {
        const stamp = ++generation;
        const result = await applyChange(
          ctx,
          subject,
          scope,
          change,
          () => generation === stamp && observed === subject,
        );
        if (result) applied.push(result);
      },
      async resume() {
        error = undefined;
        await refresh(ctx);
      },
    };
  }

  /** Native settings list in the editor area, as `/settings` does; one status entry on close. */
  async function openMenu(ctx: ExtensionContext, subject: AgentSession): Promise<void> {
    const applied: AdvisorAppliedChange[] = [];
    let discarded = false;
    let menu: AdvisorSettingsMenu | undefined;
    await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
      const opened = new AdvisorSettingsMenu(
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
    // Edits started before closing are still recorded once they settle.
    await menu?.settled();
    if (!discarded && observed === subject && applied.length) status(ctx, applied);
  }

  pi.registerCommand("advisor", {
    description: "Advisor settings menu, or on, off, inherit, set, prompt, and status",
    getArgumentCompletions: completeAdvisorCommandArguments,
    async handler(args, ctx) {
      if (privateSession) {
        pi.appendEntry("pi-advisor-status", {
          state: "private",
          error: "Private Advisor Sessions cannot create another Advisor",
        });
        return;
      }
      const subject = observed;
      let stamp = generation;
      const isCurrent = () => generation === stamp && observed === subject;
      let applied: AdvisorAppliedChange | undefined;
      try {
        if (!subject) throw new Error(error ?? "Advisor session is unavailable");
        const command = parseAdvisorCommand(args);
        if (command.action === "menu" && ctx.mode === "tui") {
          // Opening fails closed to the status entry when settings cannot be read.
          statusData(subject);
          await openMenu(ctx, subject);
          return;
        }
        if (command.action !== "status" && command.action !== "menu") {
          stamp = ++generation;
          let change: AdvisorChange;
          if (command.action === "prompt") {
            if (!ctx.hasUI)
              throw new Error("Advisor prompt editing requires UI; use /advisor set prompt <JSON>");
            const edited = await ctx.ui.editor(
              "Advisor Prompt",
              readAdvisorSettings(subject, layers).settings.prompt,
            );
            if (!isCurrent() || edited === undefined) return;
            change = {
              action: "set",
              key: "prompt",
              patch: parseAdvisorOptions({ prompt: edited }, command.scope),
            };
          } else change = command;
          applied = await applyChange(ctx, subject, command.scope, change, isCurrent);
        }
      } catch (cause) {
        if (!isCurrent()) return;
        error = cause instanceof Error ? cause.message : String(cause);
      }
      if (isCurrent()) status(ctx, applied ? [applied] : []);
    },
  });
}
