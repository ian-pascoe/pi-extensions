import * as piSdk from "@earendil-works/pi-coding-agent";
import type {
  AgentSession,
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { discoverPiAgentSession } from "@ian-pascoe/pi-utils/pi-agent-session-discovery";
import { reviewEntryType, reviewTotals } from "./guardian-audit.js";
import {
  parseGuardianCommand,
  completeGuardianCommandArguments,
  updatedToolEntries,
} from "./guardian-command.js";
import { installReviewGate } from "./guardian-gate.js";
import {
  GuardianSettingsMenu,
  type GuardianMenuHost,
  type GuardianScopedOptions,
} from "./guardian-menu.js";
import {
  guardianFooterText,
  guardianStatusHeadline,
  renderReviewEntry,
  renderStatusEntry,
  statusEntryType,
  type GuardianRenderTheme,
  type GuardianStatusEntry,
} from "./guardian-rendering.js";
import {
  guardedSessionRole,
  publishRootSession,
  rootSettingsReader,
  type GuardedSessionRole,
} from "./guardian-root-registry.js";
import {
  guardianDefaults,
  parseGuardianOptions,
  readGuardianLayers,
  readGuardianOverrides,
  readGuardianSettings,
  writeGuardianSettings,
  type GuardianAppliedChange,
  type GuardianChange,
  type GuardianLayers,
  type GuardianSettingScope,
  type ResolvedGuardianSettings,
} from "./guardian-settings.js";

/** Effective settings for this session, or why they cannot be read. */
type Effective =
  | { ok: true; resolved: ResolvedGuardianSettings; followsRoot: string | null }
  | { ok: false; error: string };

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
  /** The notice recommending a dedicated Guardian model is shown once per process. */
  let modelNoticeShown = false;

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

  const gate = installReviewGate(pi, {
    session: () => session,
    unavailable: () => discoveryError ?? "Guardian session is unavailable",
    role: () => role,
    settings() {
      const current = effective();
      // On a settings error the gate fails closed; the defaults only shape its dialogs.
      return current.ok
        ? { config: current.resolved.settings, error: undefined }
        : { config: guardianDefaults, error: current.error };
    },
    reviewingChanged: () => publishFooter(),
  });

  function publishFooter(): void {
    activeMenu?.refresh();
    if (!footer) return;
    const current = effective();
    try {
      footer.setStatus(
        "guardian",
        current.ok
          ? guardianFooterText(current.resolved.settings.enabled, gate.reviewing(), footer.theme)
          : footer.theme.fg("error", "guardian: settings error"),
      );
    } catch {
      // A replaced session's UI is stale; status entries remain authoritative.
    }
  }

  function notify(ctx: ExtensionContext, text: string, level: "info" | "warning" | "error"): void {
    if (!ctx.hasUI) return;
    try {
      ctx.ui.notify(text, level);
    } catch {
      // A replaced session's UI is stale; the review entry remains the durable record.
    }
  }

  pi.on("session_start", (_event, ctx) => {
    activeMenu?.close();
    generation++;
    // The previous session's reviews were recorded at its shutdown; drop what remains.
    gate.reset();
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
      unpublish = publishRootSession(ctx.sessionManager.getSessionId(), {
        settings: () => readGuardianSettings(subject, layers),
        userMessages: () => gate.typedUserMessages(),
      });
    }
    const current = effective();
    if (!current.ok)
      notify(ctx, `Guardian: ${current.error}. Run /skill:pi-guardian to diagnose.`, "error");
    else if (
      !modelNoticeShown &&
      role.kind === "main" &&
      current.resolved.settings.enabled &&
      current.resolved.settings.model === undefined &&
      ctx.hasUI
    ) {
      modelNoticeShown = true;
      notify(
        ctx,
        "Guardian reviews with the session's model, which can be slow and costly for every review. Pick a small, fast model with thinking off in /guardian (Model), such as anthropic/claude-haiku-4-5.",
        "info",
      );
    }
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
    gate.flush();
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
