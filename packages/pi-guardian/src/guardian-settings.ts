import type {
  AgentSession,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  defineLayeredSettings,
  type LayeredSettingChange,
  type LayeredSettingsLayers,
} from "@ian-pascoe/pi-utils/layered-settings";
import { Type, type Static } from "typebox";

/** A Tool Policy: run without review, send to the Guardian, or block outright. */
export const toolPolicySchema = Type.Union([
  Type.Literal("allow"),
  Type.Literal("review"),
  Type.Literal("deny"),
]);
export type ToolPolicy = Static<typeof toolPolicySchema>;

export const thinkingLevelSchema = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
  Type.Literal("max"),
]);
export type GuardianThinkingLevel = Static<typeof thinkingLevelSchema>;

const positiveInteger = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });

/** Authored Guardian options; every key is optional so absent values inherit. */
export const guardianOptionsSchema = Type.Object(
  {
    enabled: Type.Optional(Type.Boolean()),
    model: Type.Optional(Type.String({ minLength: 1 })),
    thinkingLevel: Type.Optional(thinkingLevelSchema),
    /** Per-tool Tool Policies; `null` resets an inherited entry to the built-in default. */
    tools: Type.Optional(
      Type.Record(Type.String({ minLength: 1 }), Type.Union([toolPolicySchema, Type.Null()])),
    ),
    /** Extra Safe Command prefixes, such as `npm test`; merged across scopes as a union. */
    safeCommands: Type.Optional(
      Type.Array(Type.String({ minLength: 1, pattern: "\\S" }), { uniqueItems: true }),
    ),
    /** Security Policy added to the Guardian's built-in policy. */
    policy: Type.Optional(Type.String()),
    reviewTimeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_147_483_647 })),
    evidenceBudgetTokens: Type.Optional(Type.Union([positiveInteger, Type.Literal("auto")])),
    onDeny: Type.Optional(Type.Union([Type.Literal("block"), Type.Literal("ask")])),
    maxConsecutiveRejections: Type.Optional(
      Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    ),
  },
  { additionalProperties: false },
);

/** Authored options; absent values inherit rather than disabling their setting. */
export type GuardianOptions = Static<typeof guardianOptionsSchema>;
/** Fully defaulted settings; an absent model follows the Guarded Agent's current model. */
export interface GuardianConfig {
  enabled: boolean;
  model?: string;
  thinkingLevel: GuardianThinkingLevel;
  /** Effective Tool Policies after merging every scope's entries. */
  tools: Record<string, ToolPolicy>;
  safeCommands: string[];
  policy: string;
  reviewTimeoutMs: number;
  evidenceBudgetTokens: number | "auto";
  onDeny: "block" | "ask";
  maxConsecutiveRejections: number;
}

export const guardianSettingScopeSchema = Type.Union([
  Type.Literal("session"),
  Type.Literal("global"),
  Type.Literal("project"),
]);
export type GuardianSettingScope = Static<typeof guardianSettingScopeSchema>;
export const guardianSettingSourceSchema = Type.Union([
  Type.Literal("default"),
  guardianSettingScopeSchema,
]);
export type GuardianSettingSource = Static<typeof guardianSettingSourceSchema>;

export const guardianDefaults: GuardianConfig = {
  enabled: true,
  thinkingLevel: "low",
  tools: {},
  safeCommands: [],
  policy: "",
  reviewTimeoutMs: 60_000,
  evidenceBudgetTokens: "auto",
  onDeny: "block",
  maxConsecutiveRejections: 3,
};

/** Pi's branch summarization uses the same fallback for models without a declared window. */
const fallbackWindow = 128_000;
const autoEvidenceCeiling = 32_000;

/**
 * Evidence token budget. `auto` is a quarter of the Guardian model's context window, at most 32K:
 * every Reviewed Call blocks the agent until its review ends, so evidence stays small.
 */
export function evidenceBudget(
  setting: GuardianConfig["evidenceBudgetTokens"],
  contextWindow: number | undefined,
): number {
  if (setting !== "auto") return contextWindow ? Math.min(setting, contextWindow) : setting;
  return Math.min(Math.floor((contextWindow || fallbackWindow) / 4), autoEvidenceCeiling);
}

const layered = defineLayeredSettings({
  namespace: "guardian",
  label: "Guardian",
  schema: guardianOptionsSchema,
  defaults: guardianDefaults,
  sessionEntryType: "pi-guardian-settings",
  merge: {
    // Each scope adds or replaces entries; `null` drops the inherited entry.
    tools: (current: GuardianConfig["tools"], next: NonNullable<GuardianOptions["tools"]>) => {
      const merged = { ...current };
      for (const [name, policy] of Object.entries(next)) {
        if (policy === null) delete merged[name];
        else merged[name] = policy;
      }
      return merged;
    },
    safeCommands: (current: string[], next: string[]) => [...new Set([...current, ...next])],
  },
});

export const guardianOptionKeys = layered.optionKeys;

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: Native settings and command input contain arbitrary authored JSON; the shared layered-settings schema check validates it before use.
export function parseGuardianOptions(value: unknown, source: GuardianSettingScope) {
  return layered.parseOptions(value, source);
}

/** Reject inherited or unknown property names before applying an authored change. */
export function guardianOptionKey(input: string): keyof GuardianOptions {
  return layered.optionKey(input);
}

/** Replay only the selected branch's last complete override snapshot. */
export function readGuardianOverrides(manager: Pick<SessionManager, "getBranch">): GuardianOptions {
  return layered.readOverrides(manager);
}

/** Authored scopes cached at startup/reload and updated after this extension's own writes. */
export type GuardianLayers = LayeredSettingsLayers<GuardianOptions>;
/** A validated authored mutation, independent of its persistence scope. */
export type GuardianChange = LayeredSettingChange<GuardianOptions>;
/** An applied change as recorded for confirmation; `options` is empty when the key inherits. */
export const guardianAppliedChangeSchema = Type.Object({
  scope: guardianSettingScopeSchema,
  key: Type.KeyOf(guardianOptionsSchema),
  options: guardianOptionsSchema,
});
export type GuardianAppliedChange = Static<typeof guardianAppliedChangeSchema>;

/** Read Pi's stored layers, preserving configuration failures until corrected. */
export function readGuardianLayers(manager: SettingsManager): GuardianLayers {
  return layered.readLayers(manager);
}

/** Effective settings with the scope that supplied each key. */
export interface ResolvedGuardianSettings {
  settings: GuardianConfig;
  sources: Record<string, GuardianSettingSource>;
}

/** Resolve stored scopes: default < global < trusted project < session. */
export function readGuardianSettings(
  session: Pick<AgentSession, "settingsManager" | "sessionManager">,
  authored = readGuardianLayers(session.settingsManager),
): ResolvedGuardianSettings {
  return layered.readSettings(session, authored);
}

/** Write one change to Pi's global or trusted project settings document. */
export function writeGuardianSettings(
  manager: SettingsManager,
  scope: "global" | "project",
  change: GuardianChange,
  isCurrent: () => boolean,
): Promise<GuardianOptions | undefined> {
  return layered.writeSettings(manager, scope, change, isCurrent);
}
