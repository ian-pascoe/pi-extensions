import {
  AgentSession,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { isDeepStrictEqual } from "node:util";
import { Text } from "@earendil-works/pi-tui";
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
  type AdvisorConfig,
} from "./advisor-settings.js";
import { completeAdvisorCommandArguments, parseAdvisorCommand } from "./advisor-command.js";
import { AdvisorObserver } from "./advisor-observer.js";
import { isAdvisorSession, type AdvisorResourceInputs } from "./advisor-session.js";

interface WatchedChild {
  agentId: string;
  resourceInputs: AdvisorResourceInputs;
  observer: AdvisorObserver | undefined;
}
const childRequestSchema = Type.Object({
  rootSessionId: Type.String(),
  agentId: Type.String(),
  session: Type.Unknown(),
  attach: Type.Function([Type.Unknown()], Type.Void()),
  resourceInputs: Type.Object({
    agentDir: Type.String({ minLength: 1 }),
    extensions: Type.Array(Type.Unknown()),
    flagValues: Type.Unknown(),
  }),
});

/** Review an observed session without changing its tools or standing instructions. */
export default function advisor(pi: ExtensionAPI): void {
  let observed: AgentSession | undefined;
  let error: string | undefined;
  let layers: AdvisorLayers = { global: {}, project: {} };
  let generation = 0;
  let privateSession = false;
  let observer: AdvisorObserver | undefined;
  let rootSessionId: string | undefined;
  const children = new Map<AgentSession, WatchedChild>();
  let unsubscribe: (() => void) | undefined = pi.events.on(
    "pi-minimal-subagents:observe-session",
    attachChild,
  );

  pi.registerEntryRenderer(
    "pi-advisor-child",
    (entry) => new Text(`Advisor for Child Agent\n${JSON.stringify(entry.data, null, 2)}`, 0, 0),
  );

  pi.registerEntryRenderer(
    "pi-advisor-status",
    (entry) => new Text(`Advisor\n${JSON.stringify(entry.data, null, 2)}`, 0, 0),
  );

  pi.on("session_start", async (_event, ctx) => {
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
    if (privateSession) return;
    const found = discoverPiAgentSession(pi, AgentSession);
    if (found.ok) {
      observed = found.session;
      layers = readAdvisorLayers(observed.settingsManager);
      await refresh(ctx);
    } else error = found.warning;
  });
  pi.on("session_tree", async (_event, ctx) => {
    generation++;
    observer?.reset();
    for (const child of children.values()) child.observer?.reset();
    await refresh(ctx);
  });
  pi.on("session_compact", () => observer?.reset());
  pi.on("model_select", () => observer?.reset());
  pi.on("before_agent_start", () => observer?.beforeTask());
  pi.on("agent_settled", () => observer?.settled());
  pi.on("session_shutdown", async () => {
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
          if (children.get(session) === child)
            pi.appendEntry("pi-advisor-child", {
              agentId: child.agentId,
              state: "paused",
              error: message,
            });
        },
        onIntervention: (finding) => {
          if (children.get(session) === child)
            pi.appendEntry("pi-advisor-child", { agentId: child.agentId, ...finding });
        },
      });
  }

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: The native owner bus is a boundary; validate identity, SDK instance, and exact resource metadata before attachment.
  function attachChild(payload: unknown): void {
    if (!Value.Check(childRequestSchema, payload) || !(payload.session instanceof AgentSession))
      return;
    if (!observed) {
      const found = discoverPiAgentSession(pi, AgentSession);
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
            onError: (message) =>
              pi.appendEntry("pi-advisor-status", { state: "paused", error: message }),
          },
        );
      for (const [session, child] of children) configureChild(session, child, settings);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      await Promise.all([
        observer?.dispose(),
        ...[...children.values()].map((child) => child.observer?.dispose()),
      ]);
      observer = undefined;
      for (const child of children.values()) child.observer = undefined;
    }
  }

  function status(ctx: ExtensionContext): void {
    try {
      if (!observed) throw new Error(error ?? "Advisor session is unavailable");
      const resolved = readAdvisorSettings(observed, layers);
      pi.appendEntry("pi-advisor-status", {
        state: resolved.settings.enabled ? "armed" : "disabled",
        ...resolved,
        backlog: 0,
        usage: null,
        cost: null,
        ...observer?.status,
        children: [...children.values()].map((child) => ({
          agentId: child.agentId,
          ...child.observer?.status,
        })),
        error: error ?? observer?.status.lastError ?? null,
      });
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      pi.appendEntry("pi-advisor-status", { state: "paused", error, usage: null, cost: null });
    }
    if (error) ctx.ui.notify(`Advisor: ${error}`, "error");
  }

  pi.registerCommand("advisor", {
    description: "Advisor on, off, inherit, scoped settings, prompt editor, or status",
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
      try {
        if (!subject) throw new Error(error ?? "Advisor session is unavailable");
        const command = parseAdvisorCommand(args);
        if (command.action !== "status") {
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
              patch: parseAdvisorOptions({ prompt: edited }, command.scope),
            };
          } else change = command;
          if (command.scope === "session") {
            const overrides = readAdvisorOverrides(subject.sessionManager);
            if (change.action === "inherit") delete overrides[change.key];
            else Object.assign(overrides, change.patch);
            pi.appendEntry("pi-advisor-settings", { version: 1, overrides });
          } else {
            const updated = await writeAdvisorSettings(
              subject.settingsManager,
              command.scope,
              change,
              isCurrent,
            );
            if (!isCurrent() || !updated) return;
            layers[command.scope] = updated;
          }
          error = undefined;
          await refresh(ctx);
        }
      } catch (cause) {
        if (!isCurrent()) return;
        error = cause instanceof Error ? cause.message : String(cause);
      }
      if (isCurrent()) status(ctx);
    },
  });
}
