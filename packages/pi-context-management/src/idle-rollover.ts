import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentSession, CacheWarmingStatus } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

/** Effective Idle Rollover configuration. */
export interface IdleRolloverSettings {
  enabled: boolean;
  /** Native context usage below which an idle Context Window is left alone. */
  minTokens: number;
}

export const IDLE_ROLLOVER_DEFAULTS: IdleRolloverSettings = { enabled: true, minTokens: 200_000 };

const IdleRolloverOptions = Type.Object(
  {
    enabled: Type.Optional(Type.Boolean()),
    minTokens: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
  },
  { additionalProperties: false },
);
/** Any `contextManagement` object that authored `idleRollover`; other keys are legacy and ignored. */
const AuthoredIdleRollover = Type.Object({ idleRollover: Type.Unknown() });

/** Effective settings and the scopes whose `idleRollover` value was invalid and skipped. */
export interface IdleRolloverSettingsRead {
  settings: IdleRolloverSettings;
  invalid: Array<"global" | "project">;
}

type SettingsReader = Pick<
  AgentSession["settingsManager"],
  "getGlobalSettings" | "getProjectSettings" | "isProjectTrusted"
>;

/** `contextManagement.idleRollover` from global then trusted project settings; invalid layers are skipped. */
export function readIdleRolloverSettings(reader: SettingsReader): IdleRolloverSettingsRead {
  const settings = { ...IDLE_ROLLOVER_DEFAULTS };
  const invalid: IdleRolloverSettingsRead["invalid"] = [];
  const layers: Array<["global" | "project", object]> = [["global", reader.getGlobalSettings()]];
  if (reader.isProjectTrusted()) layers.push(["project", reader.getProjectSettings()]);
  for (const [scope, document] of layers) {
    const block: unknown = Object.getOwnPropertyDescriptor(document, "contextManagement")?.value;
    if (!Value.Check(AuthoredIdleRollover, block)) continue;
    const value = block.idleRollover;
    if (value === undefined) continue;
    if (!Value.Check(IdleRolloverOptions, value)) {
      invalid.push(scope);
      continue;
    }
    if (value.enabled !== undefined) settings.enabled = value.enabled;
    if (value.minTokens !== undefined) settings.minTokens = value.minTokens;
  }
  return { settings, invalid };
}

/** Lifetime of the prompt cache entry Pi's requests write, as Pi's cache warmer derives it. */
export function promptCacheTtlMs(
  model: Model<Api> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const seconds = model?.promptCache?.[env.PI_CACHE_RETENTION === "long" ? "long" : "short"];
  return seconds === undefined ? undefined : seconds * 1000;
}

/** Pi's cache refresh point: 90% of the lifetime, keeping at least ten seconds of margin. */
export function cacheRefreshDelayMs(ttlMs: number): number | undefined {
  if (ttlMs <= 10_000) return undefined;
  return Math.max(1, Math.floor(Math.min(ttlMs * 0.9, ttlMs - 10_000)));
}

/** Lets Pi's own refresh decision, made at the same refresh point, land first. */
export const WARMING_SETTLE_MS = 2_000;

/** One idle period's cache entry, refreshed by each Pi cache warm. */
export interface IdleCacheWindow {
  /** When the cache entry was last written or refreshed. */
  touchedAt: number;
  ttlMs: number;
  delayMs: number;
}

/** Latest Pi cache warm recorded on the branch after `since`. */
export function latestCacheWarm(
  entries: ReadonlyArray<{ type: string; kind?: unknown; timestamp: string }>,
  since: number,
): number | undefined {
  let latest: number | undefined;
  for (const entry of entries) {
    if (entry.type !== "usage" || entry.kind !== "cache_warm") continue;
    const at = Date.parse(entry.timestamp);
    if (at > since && (latest === undefined || at > latest)) latest = at;
  }
  return latest;
}

export type IdleDecision =
  /** Check again at `at`; Pi refreshed the cache or may still refresh it. */
  | { action: "wait"; at: number }
  /** Pi will not refresh the cache and it is still warm: roll over now. */
  | { action: "rollover" }
  /** The cache has (likely) expired; a Rollover would no longer read it cheaply. */
  | { action: "expired" };

/**
 * Decide at a refresh point whether Pi's idle cache warming still keeps the entry alive.
 * Idle Rollover runs only once warming stops (or never ran), before the entry expires.
 */
export function decideIdle(
  window: IdleCacheWindow,
  status: CacheWarmingStatus | undefined,
  now: number,
): IdleDecision {
  const refreshAt = window.touchedAt + window.delayMs;
  if (now < refreshAt + WARMING_SETTLE_MS)
    return { action: "wait", at: refreshAt + WARMING_SETTLE_MS };
  if (status?.state === "refreshing") return { action: "wait", at: now + WARMING_SETTLE_MS };
  if (status?.state === "scheduled" && status.nextWarmAt !== undefined && status.nextWarmAt >= now)
    return { action: "wait", at: status.nextWarmAt + WARMING_SETTLE_MS };
  // Pi's own late-refresh cutoff: half the margin between the refresh point and expiry.
  const deadline = refreshAt + Math.floor((window.ttlMs - window.delayMs) / 2);
  return now <= deadline ? { action: "rollover" } : { action: "expired" };
}
