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
import { errorMessage, notify } from "./guardian-notify.js";
import { modelName } from "./guardian-review.js";
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
import type { ApprovedDelegation, RootUserMessage } from "./guardian-evidence.js";
import {
  approvedDelegations,
  guardedSessionRole,
  publishDelegations,
  publishRootSession,
  rootAgentId,
  rootSession,
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
  /**
   * What a Child Agent or Advisor last read from its root. Once followed, a root that ended or
   * was replaced keeps governing: falling back to this session's own, possibly laxer, settings
   * would let a delegated session outlive its root's policy.
   */
  let lastRoot:
    | { rootSessionId: string; resolved: ResolvedGuardianSettings; userMessages: RootUserMessage[] }
    | undefined;
  /** A Child Agent's parent's approved delegations, kept after the parent leaves like `lastRoot`. */
  let lastDelegations: ApprovedDelegation[] = [];

  // Allowed reviews stay out of the transcript unless `verbose` is on; their entries still count.
  pi.registerEntryRenderer(reviewEntryType, (entry, { expanded }, theme) => {
    const current = effective();
    return renderReviewEntry(
      entry.data,
      expanded,
      theme,
      current.ok && current.resolved.settings.verbose,
    );
  });
  pi.registerEntryRenderer(statusEntryType, (entry, { expanded }, theme) =>
    renderStatusEntry(entry.data, expanded, theme),
  );

  /** Refresh what this delegated session follows from its root, if the root is published. */
  function followRoot(): typeof lastRoot {
    if (role.kind === "main") return undefined;
    const root = rootSession(role.rootSessionId);
    if (root)
      lastRoot = {
        rootSessionId: root.rootSessionId(),
        resolved: root.settings(),
        userMessages: root.userMessages(),
      };
    return lastRoot;
  }

  /**
   * Effective settings: the root session's for Child Agents and Advisors (the last known ones
   * after the root leaves), else this session's.
   */
  function effective(): Effective {
    try {
      const root = followRoot();
      if (root) return { ok: true, resolved: root.resolved, followsRoot: root.rootSessionId };
      if (!session)
        return { ok: false, error: discoveryError ?? "Guardian session is unavailable" };
      return { ok: true, resolved: readGuardianSettings(session, layers), followsRoot: null };
    } catch (cause) {
      return { ok: false, error: errorMessage(cause) };
    }
  }

  const gate = installReviewGate(pi, {
    session: () => session,
    unavailable: () => discoveryError ?? "Guardian session is unavailable",
    role: () => role,
    rootUserMessages: () => (role.kind === "main" ? [] : (lastRoot?.userMessages ?? [])),
    delegator() {
      if (role.kind !== "child" || role.parentAgentId === undefined) return undefined;
      const published = approvedDelegations(role.rootSessionId, role.parentAgentId);
      if (published) lastDelegations = published;
      return { agentId: role.parentAgentId, selfId: role.agentId, approved: lastDelegations };
    },
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

  pi.on("session_start", (_event, ctx) => {
    activeMenu?.close();
    generation++;
    // The previous session's reviews were recorded at its shutdown; drop what remains.
    gate.reset();
    unpublish?.();
    unpublish = undefined;
    role = guardedSessionRole(ctx.sessionManager.getBranch());
    lastRoot = undefined;
    lastDelegations = [];
    footer = ctx.hasUI ? ctx.ui : undefined;
    const found = discoverPiAgentSession(pi, piSdk.AgentSession);
    if (found.ok) {
      session = found.session;
      discoveryError = undefined;
      try {
        layers = readGuardianLayers(session.settingsManager);
      } catch (cause) {
        layers = { global: new Error(errorMessage(cause)), project: {} };
      }
    } else {
      session = undefined;
      discoveryError = `Guardian cannot read this session's settings: ${found.warning}`;
    }
    const sessionId = ctx.sessionManager.getSessionId();
    const unpublishers: (() => void)[] = [];
    if (role.kind === "main" && session) {
      const subject = session;
      unpublishers.push(
        publishRootSession(sessionId, {
          rootSessionId: () => sessionId,
          settings: () => readGuardianSettings(subject, layers),
          userMessages: () => gate.typedUserMessages(),
        }),
        publishDelegations(sessionId, rootAgentId, () => gate.approvedDelegations()),
      );
    } else if (role.kind !== "main") {
      // Republish the root, so an Advisor observing this Child Agent follows the real root.
      const followed = role.rootSessionId;
      unpublishers.push(
        publishRootSession(sessionId, {
          rootSessionId: () => followRoot()?.rootSessionId ?? followed,
          settings() {
            const current = effective();
            if (!current.ok) throw new Error(current.error);
            return current.resolved;
          },
          userMessages: () => followRoot()?.userMessages ?? [],
        }),
      );
      // A Child Agent's own delegations, for its children: nested delegation.
      if (role.kind === "child" && role.agentId !== undefined)
        unpublishers.push(
          publishDelegations(role.rootSessionId, role.agentId, () => gate.approvedDelegations()),
        );
    }
    unpublish = () => {
      for (const release of unpublishers) release();
    };
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

  /** The authored `tools` or `commands` option at one scope. */
  function authoredEntries(
    subject: AgentSession,
    scope: GuardianSettingScope,
    key: "tools" | "commands",
  ) {
    if (scope === "session") return readGuardianOverrides(subject.sessionManager)[key];
    const layer = layers[scope];
    if (layer instanceof Error) throw layer;
    return layer[key];
  }

  /** Persist one validated change at its scope; undefined if superseded. */
  async function applyChange(
    subject: AgentSession,
    scope: GuardianSettingScope,
    change: GuardianChange,
    isCurrent: () => boolean,
  ): Promise<GuardianAppliedChange | undefined> {
    if (followRoot())
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
          models: ctx.modelRegistry.getAvailable().map(modelName),
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
        } else if (command.action === "tool" || command.action === "command") {
          const key = command.action === "tool" ? "tools" : "commands";
          const entries = updatedToolEntries(
            authoredEntries(subject, command.scope, key),
            command.action === "tool" ? command.name : command.prefix,
            command.value,
          );
          change = entries
            ? {
                action: "set",
                key,
                patch: parseGuardianOptions({ [key]: entries }, command.scope),
              }
            : { action: "inherit", key };
        } else change = command;
        applied = await applyChange(subject, command.scope, change, isCurrent);
      } catch (cause) {
        if (!isCurrent()) return;
        error = errorMessage(cause);
      }
      if (isCurrent()) status(ctx, applied ? [applied] : [], error);
    },
  });
}
